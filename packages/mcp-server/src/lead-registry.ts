/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import {getSnapshotByHandle, listSnapshots} from './heap-state.js';
import {cachedPathLabeler} from './heap-families.js';
import {heldByLabel} from './utils.js';

/**
 * The leads analysis tools printed this session, per snapshot, so
 * `memlab_coverage_check` can list the ones a draft report never names. In 27
 * agent runs, leads printed in every transcript of a scenario were missing
 * from every report.
 */

/** The first four are evidence against a "bounded" or "expected" verdict. */
export type LeadKind =
  'dead' | 'duplicate' | 'finished' | 'growing' | 'residual' | 'large';

export interface RecordedLead {
  label: string;
  ids: number[];
  bytes: number;
  kind: LeadKind;
  /** One line: the evidence the tool printed. */
  why: string;
  source: string;
  /** Shortest-path owner, e.g. `module:WebLoom.$4`. */
  path?: string;
  /** The node's class name. */
  name?: string;
  /** A `Class.prop` edge, for a family with no single node. */
  edge?: string;
  /** The call that checks it, when not the default for its kind. */
  check?: string;
  /** Snapshot handle, '' for a ladder-wide lead. */
  snapshot: string;
}

/** Label, bytes, ids, path and name default from `node`. */
export type LeadInput = Partial<Omit<RecordedLead, 'snapshot' | 'name'>> &
  Pick<RecordedLead, 'kind' | 'why' | 'source'> & {node?: IHeapNode | null};

const PER_SNAPSHOT = 400;
const BOOKS = 16;
const rank = (k: LeadKind) => (k === 'large' ? 1 : k === 'residual' ? 2 : 3);

type Book = {handle: string; leads: Map<string, RecordedLead>};
const books: Book[] = [];
// Keyed weakly: the leads outlive an unloaded snapshot, the snapshot does not.
const bookOf = new WeakMap<IHeapSnapshot, Book>();

function bookFor(s: IHeapSnapshot | null): Book {
  const known = s != null ? bookOf.get(s) : books.find(b => b.handle === '');
  if (known != null) return known;
  const handle =
    s == null
      ? ''
      : (listSnapshots().find(m => getSnapshotByHandle(m.handle) === s)
          ?.handle ?? '?');
  const book = {handle, leads: new Map<string, RecordedLead>()};
  books.push(book);
  if (books.length > BOOKS) books.shift();
  if (s != null) bookOf.set(s, book);
  return book;
}

/** Record one lead; the same node or edge keeps its strongest evidence. */
export function recordLead(s: IHeapSnapshot | null, l: LeadInput): void {
  try {
    const n = l.node ?? null;
    const ids = n != null ? [n.id] : (l.ids ?? []).slice(0, 3);
    const label = l.label ?? (n != null ? heldByLabel(n, 200) : '-');
    // Script source text is loaded code, not state a report would name.
    if (label.startsWith('source of ')) return;
    const key = ids.length > 0 ? `@${ids[0]}` : (l.edge ?? label);
    const book = bookFor(s);
    const old = book.leads.get(key);
    let path = l.path;
    if (path == null && n != null && s != null) {
      path = cachedPathLabeler(s).labelOf(n);
    }
    const lead: RecordedLead = {
      label,
      ids,
      bytes: Math.max(0, l.bytes ?? n?.retainedSize ?? 0),
      kind: l.kind,
      why: l.why,
      source: l.source,
      snapshot: book.handle,
      ...(path != null ? {path} : {}),
      ...(n != null ? {name: n.name} : {}),
      ...(l.edge != null ? {edge: l.edge} : {}),
      ...(l.check != null ? {check: l.check} : {}),
    };
    if (old != null) {
      const keepOld = rank(old.kind) >= rank(lead.kind);
      const merged = keepOld ? old : {...old, ...lead};
      merged.bytes = Math.max(old.bytes, lead.bytes);
      const from = old.source.split('+');
      merged.source = (
        from.includes(l.source) ? from : [...from, l.source]
      ).join('+');
      merged.path ??= path;
      book.leads.set(key, merged);
      return;
    }
    if (book.leads.size >= PER_SNAPSHOT) return;
    book.leads.set(key, lead);
  } catch {
    // Bookkeeping must never fail the tool that found the lead.
  }
}

/** Every lead recorded this session, oldest snapshot first. */
export function allLeads(): RecordedLead[] {
  return books.flatMap(b => [...b.leads.values()]);
}

export function clearLeads(): void {
  books.length = 0;
}

/** A framework-buffer flag as a lead kind. */
export const flagKind = (flag: string): LeadKind =>
  /cancel/.test(flag) ? 'dead' : /per-call/.test(flag) ? 'growing' : 'large';

const SWEEP_KIND: Record<number, [LeadKind, string]> = {
  1: ['large', 'sweep top retained'],
  2: ['dead', 'collection ≥25% dead entries'],
  3: ['duplicate', 'string family'],
  6: ['finished', 'async flag'],
  7: ['growing', 'grew across the ladder'],
};

/**
 * memlab_sweep's leads (its section-8 list): call once per sweep, after the
 * sections ran, with the swept snapshot.
 */
export function recordSweepLeads(
  s: IHeapSnapshot,
  leads: ReadonlyArray<{
    label: string;
    bytes: number;
    section: number;
    ids?: number[];
    edge?: string;
  }>,
): void {
  for (const l of leads) {
    // Section 4 labels start with the buffer's flag.
    const flag = l.section === 4 ? l.label.split(':')[0] : '';
    const [kind, why] =
      flag !== ''
        ? [flagKind(flag), flag]
        : (SWEEP_KIND[l.section] ?? ['large', 'sweep lead']);
    const node = l.ids?.length === 1 ? s.getNodeById(l.ids[0]) : null;
    // A growth anchor comes without bytes: its retained size stands in.
    const bytes = l.bytes > 0 ? l.bytes : undefined;
    recordLead(s, {...l, bytes, kind, why, source: 'sweep', node});
  }
}
