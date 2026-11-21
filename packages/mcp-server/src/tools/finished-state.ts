/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {resolveRungs, withSnapshotAt} from '../snapshot-borrow.js';
import {
  enumerateMapEntries,
  enumerateSetElements,
  errorResult,
  formatBytes,
  formatNumber,
  heldByLabel,
  markdownTable,
  pathsHeader,
  sanitizeForTable,
  stratifyNodes,
  toolResult,
} from '../utils.js';
import {loadSnapshotByPath} from './explain-delta.js';
import {
  auditFields,
  classifyValue,
  decodeTimes,
  formatDuration,
  type FieldValue,
  timestampScale,
} from './field-fill.js';
import {arrayElements} from './framework-buffers.js';

/**
 * `memlab_finished_state`: objects whose own fields say they are finished (a
 * trace with `traceStatus:"SUCCESS"`, a stream with `completed:true`, a
 * context in `UPLOAD_PENDING`) but that still own a large buffer. Every
 * memlab run in the A/B study missed these: a top-retained table shows a
 * 700 KB trace as one more row, and only its status says it is done.
 */

const STATUS_NAME = /(^|_|[a-z])(status|state|phase|stage)$/i;
const NOT_STATUS = /^(memoized|base|prev|next|initial|default|saved)State$/;
/** Terminal values, lower-cased with everything but letters removed. */
const TERMINAL = new Set(
  (
    'success succeeded successful complete completed done finished finish ' +
    'closed cancel canceled cancelled failed fail failure error errored ' +
    'aborted abort ended timeout timedout resolved rejected fulfilled ' +
    'settled disposed destroyed terminated stopped expired uploaded flushed ' +
    'committed unmounted finalized released'
  ).split(' '),
);
/** Done collecting, waiting to be shipped. */
const AWAITING = /^(upload|flush|send|report)(ing)?pending$/;
const FLAG_NAME =
  /^_*(is|has|was)?_?(complete|completed|done|finished|ended|closed|cancell?ed|aborted|disposed|destroyed|terminated|settled|unmounted|stopped)$/i;
const STAMP_NAME =
  /^_*(completed|finished|ended)(_?at|_?time|_?ts)?$|^(complete|finish|end)_?(time|ts)$/i;
const OBSERVER_NAME =
  /^_*\$?(observers|subscribers|subscriptions|listeners|callbacks|handlers|sinks|waiters)$/i;
/** The smallest buffer worth a row: below it the object is a record. */
const MIN_BUFFER = 16 * 1024;
/** A finished request's product, read by whoever awaited it. */
const PRODUCT = /^(response|result|results|value|data)$/i;

/**
 * Whether one field says its object is finished, as display text
 * (`traceStatus="SUCCESS"`, `completed=true`, `completed=5,909`), else null.
 * `numberName` tells a heap number (a timestamp) from a small integer when
 * the capture recorded no numeric values.
 */
export function finishedEvidence(
  field: string,
  v: FieldValue,
  numberName = '',
): string | null {
  if (v.kind === 'string') {
    if (!STATUS_NAME.test(field) || NOT_STATUS.test(field)) return null;
    const raw = JSON.parse(v.key) as string;
    const norm = raw.toLowerCase().replace(/[^a-z]/g, '');
    return TERMINAL.has(norm) || AWAITING.test(norm)
      ? `${field}=${JSON.stringify(raw.slice(0, 24))}`
      : null;
  }
  if (v.kind === 'other' && v.key === 'true' && FLAG_NAME.test(field)) {
    return `${field}=true`;
  }
  if (v.kind !== 'number' || !STAMP_NAME.test(field)) return null;
  if (v.num != null) {
    return v.num > 0 ? `${field}=${formatNumber(Math.round(v.num))}` : null;
  }
  return numberName === 'heap number' ? `${field}=<number>` : null;
}

function collectionSize(t: IHeapNode): number | null {
  if (t.name === 'Array') return arrayElements(t).length;
  if (t.name === 'Map') return enumerateMapEntries(t).length;
  if (t.name === 'Set') return enumerateSetElements(t).length;
  return null;
}

type Child = {name: string; node: IHeapNode; shared: boolean};

/**
 * The object children `n` dominates; with `shared`, also those it holds with
 * at most 3 others (a trace context kept by its registry entry and by the
 * provider that created it is dominated by neither).
 */
function ownedChildren(n: IHeapNode, shared = false): Child[] {
  const out: Child[] = [];
  for (const e of n.references) {
    if (e.type !== 'property' && e.type !== 'internal') continue;
    const name = String(e.name_or_index);
    const t = e.toNode;
    if (name === '__proto__' || name === 'map' || t.type !== 'object') continue;
    const owned = t.dominatorNode?.id === n.id;
    if (!owned) {
      if (!shared || e.type !== 'property' || t.retainedSize < 1024) continue;
      let holders = 0;
      for (const r of t.referrers) {
        if (r.type !== 'weak' && r.type !== 'shortcut') holders++;
      }
      if (holders > 4) continue;
    }
    const label = e.type === 'internal' ? `(${name})` : name;
    out.push({name: label, node: t, shared: !owned});
  }
  return out;
}

/** Roots of the retained subtrees held by this object, including co-held ones. */
function heldRoots(n: IHeapNode): IHeapNode[] {
  return [
    n,
    ...ownedChildren(n, true)
      .filter(c => c.shared)
      .map(c => c.node),
  ];
}

/** Sum distinct retained subtrees, excluding roots dominated by another root. */
function retainedBytes(nodes: IHeapNode[]): number {
  const roots = new Map(nodes.map(n => [n.id, n]));
  let bytes = 0;
  for (const n of roots.values()) {
    let parent = n.dominatorNode;
    const seen = new Set([n.id]);
    let covered = false;
    while (parent != null && !seen.has(parent.id)) {
      if (roots.has(parent.id)) {
        covered = true;
        break;
      }
      seen.add(parent.id);
      parent = parent.dominatorNode;
    }
    if (!covered) bytes += n.retainedSize;
  }
  return bytes;
}

/** Retained bytes plus the distinct children held with a few others. */
export function heldBytes(n: IHeapNode): number {
  return retainedBytes(heldRoots(n));
}

export interface BufferInfo {
  path: string;
  bytes: number;
  /** Array elements, Map/Set entries, or the sum over a table of arrays. */
  entries: number;
  keys?: number;
  /** The buffer's records, for timestamp decoding. */
  records: IHeapNode[];
}

/** Measure a collection, or a table of arrays, as a buffer. */
function measureBuffer(t: IHeapNode, path: string): BufferInfo {
  const size = collectionSize(t);
  const bytes = t.retainedSize;
  if (size != null) {
    const records =
      t.name === 'Array'
        ? arrayElements(t)
        : t.name === 'Set'
          ? enumerateSetElements(t)
          : enumerateMapEntries(t).flatMap(e => e.value ?? []);
    return {path, bytes, entries: size, records};
  }
  const kids = ownedChildren(t);
  const records: IHeapNode[] = [];
  for (const c of kids) {
    if (c.node.name !== 'Array') continue;
    for (const r of arrayElements(c.node)) records.push(r);
  }
  return {path, bytes, entries: records.length, keys: kids.length, records};
}

/**
 * The largest buffer an object owns: descend through the largest owned child
 * (at most 4 hops; the first may be co-held) to a collection or a table of
 * arrays (`reactRender: {root: [...], page: [...]}`).
 */
export function biggestBuffer(holder: IHeapNode): BufferInfo | null {
  const path: string[] = [];
  const total = heldBytes(holder);
  let cur = holder;
  for (let depth = 0; depth < 4; depth++) {
    let best: Child | null = null;
    for (const c of ownedChildren(cur, depth === 0)) {
      if (best == null || c.node.retainedSize > best.node.retainedSize) {
        best = c;
      }
    }
    if (best == null || best.node.retainedSize < total / 5) return null;
    path.push(best.name);
    cur = best.node;
    const kids = collectionSize(cur) != null ? null : ownedChildren(cur);
    const arrays = kids?.filter(k => k.node.name === 'Array').length ?? 0;
    if (kids == null || (kids.length >= 3 && arrays >= kids.length * 0.8)) {
      return measureBuffer(cur, path.join('.'));
    }
  }
  return null;
}

/** The buffer records' clock field: its span, and how far past `stamp`. */
function timesNote(records: IHeapNode[], stamp: number | null): string {
  const objects = records.filter(r => r.type === 'object');
  let best: {field: string; ms: number[]; scale: string} | null = null;
  for (const f of auditFields(stratifyNodes(objects, 10_000)).values()) {
    const ts = timestampScale(f.name, f.nums);
    if (ts != null && ts.ms.length > (best?.ms.length ?? 0)) {
      best = {field: f.name, ...ts};
    }
  }
  if (best == null) return '—';
  const t = decodeTimes(best.ms);
  let s = `\`${best.field}\` span ${formatDuration(t.span)}`;
  const stampTime =
    stamp == null ? null : timestampScale('timestamp', [stamp, stamp]);
  if (
    stamp != null &&
    best.scale === 'performance.now() ms' &&
    // Completion can precede the one-minute clock-detection threshold.
    (stampTime?.scale === best.scale || (stamp > 0 && stamp < 60_000))
  ) {
    const after = t.max - stamp;
    s +=
      after > 1000
        ? `, newest ${formatDuration(after)} AFTER completion`
        : ', none after completion';
  }
  return s;
}

export interface FinishedRow {
  holder: string;
  shape: string;
  evidence: string;
  count: number;
  bytes: number;
  /** Retained subtree roots, for a deduplicated total across rows. */
  retainedRoots: IHeapNode[];
  example: IHeapNode;
  buffer: BufferInfo;
  times: string;
}

function shapeOf(n: IHeapNode): {key: string; label: string} {
  if (n.name !== 'Object') return {key: n.name, label: n.name};
  const names = n.references
    .filter(e => e.type === 'property')
    .map(e => String(e.name_or_index))
    .filter(k => k !== '__proto__');
  const more = names.length > 4 ? ', …' : '';
  return {
    key: `{${[...names].sort().join(',')}}`,
    label: `{${names.slice(0, 4).join(', ')}${more}}`,
  };
}

interface Candidate {
  node: IHeapNode;
  bytes: number;
  evidence: string;
  evidenceKey: string;
  stamp: number | null;
}

/** One pass over objects: those with a finished field, or drained ones. */
function findCandidates(snapshot: IHeapSnapshot): Candidate[] {
  const kindOf = new Map<string, number>();
  const kind = (name: string) => {
    let k = kindOf.get(name);
    if (k == null) {
      k =
        (STATUS_NAME.test(name) && !NOT_STATUS.test(name) ? 1 : 0) |
        (FLAG_NAME.test(name) || STAMP_NAME.test(name) ? 2 : 0) |
        (OBSERVER_NAME.test(name) ? 4 : 0);
      kindOf.set(name, k);
    }
    return k;
  };
  const out: Candidate[] = [];
  snapshot.nodes.forEach(n => {
    if (n.type !== 'object') return;
    const edges = n.references.filter(
      e => e.type === 'property' && kind(String(e.name_or_index)) !== 0,
    );
    if (!edges.some(e => kind(String(e.name_or_index)) & 3)) return;
    let evidence: string | null = null;
    let evidenceKey: string | null = null;
    let numericStatus: string | null = null;
    let drained: string | null = null;
    let stamp: number | null = null;
    for (const e of edges) {
      const name = String(e.name_or_index);
      const t = e.toNode;
      if (kind(name) & 4) {
        if (collectionSize(t) === 0) drained = name;
        continue;
      }
      const v = classifyValue(t);
      const ev = finishedEvidence(name, v, t.name);
      if (ev != null) {
        if (evidence == null || STATUS_NAME.test(name)) {
          evidence = ev;
          evidenceKey =
            v.kind === 'number' && STAMP_NAME.test(name)
              ? `${name}=<completion stamp>`
              : ev;
        }
        if (STAMP_NAME.test(name) && v.num != null) stamp = v.num;
      } else if (kind(name) & 1 && v.kind === 'number') {
        numericStatus = `${name}=${v.num ?? '<number>'}`;
      }
    }
    // What a numeric status enum means is not in the heap: count it only
    // with its observers gone.
    if (evidence == null && numericStatus != null && drained != null) {
      evidence = `${numericStatus}, ${drained} empty`;
    }
    if (evidence == null) return;
    const bytes = heldBytes(n);
    if (bytes >= 256) {
      out.push({
        node: n,
        bytes,
        evidence,
        evidenceKey: evidenceKey ?? evidence,
        stamp,
      });
    }
  });
  return out;
}

/**
 * Finished objects that still own large buffers, grouped by holder, class or
 * shape, and the finished field's value; largest first.
 */
export function findFinishedState(
  snapshot: IHeapSnapshot,
  minBytes = 64 * 1024,
): FinishedRow[] {
  const groups = new Map<string, Candidate[]>();
  for (const c of findCandidates(snapshot)) {
    const key = `${heldByLabel(c.node, 60)}|${shapeOf(c.node).key}|${c.evidenceKey}`;
    const g = groups.get(key);
    if (g != null) g.push(c);
    else groups.set(key, [c]);
  }
  const rows: FinishedRow[] = [];
  for (const [key, group] of groups) {
    const retainedRoots = group.flatMap(c => heldRoots(c.node));
    const bytes = retainedBytes(retainedRoots);
    if (bytes < minBytes) continue;
    group.sort((a, b) => b.bytes - a.bytes);
    const top = group[0];
    const buffer = biggestBuffer(top.node);
    // No buffer or a small one: a record of what it did. One payload or a
    // `response`: its product, the thing it was for.
    if (
      buffer == null ||
      buffer.entries < 2 ||
      buffer.bytes < MIN_BUFFER ||
      PRODUCT.test(buffer.path.split('.')[0])
    ) {
      continue;
    }
    rows.push({
      holder: key.split('|')[0],
      shape: shapeOf(top.node).label,
      evidence: top.evidence,
      count: group.length,
      bytes,
      retainedRoots,
      example: top.node,
      buffer,
      times: timesNote(buffer.records, top.stamp),
    });
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}

/** Retained bytes across rows, counting each shared subtree only once. */
export function finishedStateBytes(rows: FinishedRow[]): number {
  return retainedBytes(rows.flatMap(r => r.retainedRoots));
}

/** The same id in an earlier snapshot: `247→5,843 entries, …: GROWING`. */
export function growthNote(row: FinishedRow, earlier: IHeapSnapshot): string {
  const then = earlier.getNodeById(row.example.id);
  if (then?.name !== row.example.name) return 'no same-id object earlier';
  let old: IHeapNode | undefined = then;
  for (const step of row.buffer.path.split('.')) {
    const name = step.replace(/^\((.*)\)$/, '$1');
    old = old?.references.find(e => String(e.name_or_index) === name)?.toNode;
  }
  if (old == null) return 'buffer absent earlier';
  const was = measureBuffer(old, row.buffer.path).entries;
  const now = row.buffer.entries;
  const verdict = now > was ? 'GROWING' : now === was ? 'frozen' : 'shrank';
  return (
    `${formatNumber(was)}→${formatNumber(now)} entries, ` +
    `${formatBytes(heldBytes(then))}→${formatBytes(heldBytes(row.example))}: ${verdict}`
  );
}

function renderRows(rows: FinishedRow[], growth: string[] | null): string {
  const cell = (s: string) => sanitizeForTable(s);
  return markdownTable(
    [
      'Holder',
      'Shape',
      'Finished by',
      'Count',
      'Retained',
      'Biggest buffer',
      'Buffer times',
      ...(growth ? ['vs earlier (example)'] : []),
      'Example',
    ],
    rows.map((r, i) => {
      const b = r.buffer;
      const n = `${b.keys != null ? `${formatNumber(b.keys)} keys, ` : ''}${formatNumber(b.entries)} entries`;
      return [
        cell(r.holder),
        cell(r.shape),
        cell(r.evidence),
        formatNumber(r.count),
        formatBytes(r.bytes),
        cell(`\`${b.path}\` ${n}, ${formatBytes(b.bytes)}`),
        cell(r.times),
        ...(growth ? [growth[i]] : []),
        `@${r.example.id}`,
      ];
    }),
    new Set([3, 4]),
  );
}

/**
 * The sweep section: finished objects still owning buffers, as a capped
 * table; nothing when there are none. `earlier` adds a same-id growth column.
 */
export function finishedStateSweepSection(
  snapshot: IHeapSnapshot,
  opts: {cap?: number; minBytes?: number; earlier?: IHeapSnapshot} = {},
): string[] {
  const rows = findFinishedState(snapshot, opts.minBytes);
  if (rows.length === 0) return [];
  const shown = rows.slice(0, opts.cap ?? 5);
  const earlier = opts.earlier;
  const growth = earlier ? shown.map(r => growthNote(r, earlier)) : null;
  return [
    `**Finished objects still owning buffers** (${shown.length} of ${rows.length} groups; a status field plus a buffer, not a verdict) → \`memlab_finished_state\``,
    '',
    renderRows(shown, growth),
    '',
  ];
}

export function registerFinishedState(server: McpServer): void {
  server.tool(
    'memlab_finished_state',
    'Objects whose own fields say they are FINISHED but that still own large buffers: traces with `traceStatus:"SUCCESS"`, contexts awaiting upload (`UPLOAD_PENDING`), streams with `completed:true` or an enum status and an empty observers Map, requests "aborted"/"error". ' +
      "One pass finds status-like fields (status, state, phase, traceStatus, …) with a terminal value, finished flags and completion stamps; groups them by holder + shape + value; and per group reports count, retained bytes, the largest owned buffer (path, entries, bytes), and the span of the buffer records' timestamps, flagging records newer than the completion stamp. " +
      'With `paths` (oldest first, 2+) it reads the same ids in the first snapshot: a buffer still growing after completion vs frozen.',
    {
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Snapshot paths, OLDEST FIRST. The LAST is analysed (and becomes active); with 2+, the first is the earlier snapshot for the growth column. Without it the active snapshot is analysed.',
        ),
      min_bytes: z
        .number()
        .optional()
        .default(64 * 1024)
        .describe('Smallest group retained size to report (default 64 KB).'),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(10)
        .describe('Rows to show (default 10).'),
    },
    async ({paths, min_bytes, limit}) => {
      try {
        const t0 = Date.now();
        let earlier: string | null = null;
        let header: string | undefined;
        if (paths != null && paths.length > 0) {
          const {rungs} = resolveRungs(paths);
          const last = rungs[rungs.length - 1];
          if ((await loadSnapshotByPath(last.localPath)) == null) {
            return errorResult(`Could not load ${last.localPath}.`);
          }
          if (rungs.length > 1) earlier = rungs[0].localPath;
          header = pathsHeader(rungs.map(r => r.label));
        }
        const rows = findFinishedState(getSnapshot(), min_bytes);
        if (rows.length === 0) {
          return toolResult(
            `No finished objects (terminal status, finished flag or completion stamp) owning ≥${formatBytes(min_bytes)} with a buffer of 2+ entries and ≥16 KB.`,
            header,
          );
        }
        const shown = rows.slice(0, limit);
        const growth =
          earlier == null
            ? null
            : await withSnapshotAt(earlier, s =>
                shown.map(r => growthNote(r, s)),
              );
        const total = finishedStateBytes(rows);
        const lines = [
          `## Finished objects still owning buffers: ${formatNumber(rows.length)} group(s), ${formatBytes(total)}`,
          '',
          renderRows(shown, growth),
          '',
          ...(rows.length > limit
            ? [`… ${rows.length - limit} more group(s); raise \`limit\`.`, '']
            : []),
          '- Each row is a status field plus a buffer, not a verdict: check whether the finished object is still meant to be read (a replay buffer, an upload queue) or should have been dropped → `memlab_retainer_trace` on the example, `memlab_field_fill({node_id})` on the buffer.',
          ...(growth
            ? [
                '- vs earlier: the example in the first snapshot, by node id. GROWING: its buffer is still appended to after it finished; frozen: retained but no longer written.',
              ]
            : []),
          '',
          `_${((Date.now() - t0) / 1000).toFixed(1)} s_`,
        ];
        return toolResult(lines.join('\n'), header);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
