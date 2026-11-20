/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapEdge, IHeapNode, IHeapSnapshot} from '@memlab/core';
import {
  formatBytes,
  formatNumber,
  heldByLabel,
  markdownTable,
  sanitizeForTable,
} from './utils.js';

/**
 * String FAMILIES: every string grouped by a normalised prefix, so 240
 * per-story `{"query_id":…` blobs of ~30 KB each read as one 7 MB row rather
 * than 240 rows that no single-string table ranks. Hand-written census
 * scripts found families this way; this is the same grouping in one pass.
 */

export const FAMILY_PREFIX_LEN = 24;

/**
 * The family of a string value: its first {@link FAMILY_PREFIX_LEN} chars with
 * each run of digits masked to `#`. A `data:` URL is keyed by everything up to
 * its first comma (`data:<mime>[;params][;base64],`, digits kept), so one
 * family per mime.
 */
export function stringFamilyKey(value: string): string {
  if (value.startsWith('data:')) {
    const comma = value.indexOf(',');
    if (comma > 5 && comma <= 120) return value.slice(0, comma + 1);
  }
  return value
    .slice(0, FAMILY_PREFIX_LEN * 2)
    .replace(/\d+/g, '#')
    .slice(0, FAMILY_PREFIX_LEN);
}

const WRAPPER_TYPES = new Set(['concatenated string', 'sliced string']);

/** A holder label is "generic" when its owner name says nothing by itself. */
const GENERIC_OWNER_RE = /^(Object|Array|\(anonymous\)|system \/ |\(object )/;

/** `Owner.edge` for one string, climbing out of any cons/sliced wrappers. */
export function stringHolderLabel(node: IHeapNode): string {
  let top = node;
  for (let hop = 0; hop < 32; hop++) {
    let up: IHeapNode | null = null;
    for (const e of top.referrers) {
      if (WRAPPER_TYPES.has(e.fromNode.type)) {
        up = e.fromNode;
        break;
      }
    }
    if (up == null) break;
    top = up;
  }
  const chosen = holderEdge(top);
  if (chosen == null) return '-';
  const from = chosen.fromNode;
  const name = String(chosen.name_or_index);
  if (chosen.type === 'context') return `closure var ${name}`;
  // An element of an array, Map/Set table or properties backing store.
  if (!isNamedEdge(chosen)) return containerLabel(top) ?? '-';
  const owner = (from.name || '(anonymous)').slice(0, 32);
  const label = `${owner}.${name}`;
  if (!GENERIC_OWNER_RE.test(owner)) return label;
  // `Object.src` alone does not say whose objects these are: name the
  // object's own holder too (`Object.resources › Object.src`).
  const anchor = anchorOf(from);
  return anchor === '-' ? label : `${anchor} › ${label}`;
}

function isNamedEdge(e: IHeapEdge): boolean {
  return (
    e.type === 'context' ||
    (e.type === 'property' && !/^\d+$/.test(String(e.name_or_index)))
  );
}

/**
 * The edge that holds a string: a named edge from its dominator, else the
 * first named edge, else the first strong one. Synthetic roots (the string
 * table, external strings) and weak edges never hold anything.
 */
function holderEdge(node: IHeapNode): IHeapEdge | null {
  const dom = node.dominatorNode;
  let named: IHeapEdge | null = null;
  let any: IHeapEdge | null = null;
  for (const e of node.referrers) {
    if (e.type === 'weak' || e.type === 'shortcut') continue;
    if (e.fromNode.type === 'synthetic') continue;
    if (isNamedEdge(e)) {
      if (dom != null && e.fromNode.id === dom.id) return e;
      named ??= e;
    }
    any ??= e;
  }
  return named ?? any;
}

const strong = (e: IHeapEdge) =>
  e.type !== 'weak' && e.type !== 'shortcut' && e.fromNode.type !== 'synthetic';

/** `heldByLabel` without its relation and `(+N)` tails, for grouping. */
function heldByAnchor(node: IHeapNode): string {
  return heldByLabel(node, 40)
    .replace(/ \(\+\d+\)$/, '')
    .replace(/ ▸ .*$/, '');
}

/**
 * `<holder>[]` for a node kept as an element: of its containers (an object
 * can sit in many Maps), the largest, since that is the collection a reader
 * would cut. A backing store (Map/Set table, elements, properties) is named
 * by the object that owns it: `closure var _resources[]`.
 */
function containerLabel(node: IHeapNode): string | null {
  let best: IHeapNode | null = null;
  for (const e of node.referrers) {
    if (!strong(e) || isNamedEdge(e)) continue;
    if (best == null || e.fromNode.self_size > best.self_size)
      best = e.fromNode;
  }
  if (best == null) return null;
  let owner = best;
  if (best.type === 'array' || best.type === 'hidden') {
    for (const e of best.referrers) {
      if (!strong(e)) continue;
      owner = e.fromNode;
      break;
    }
  }
  const anchor = heldByAnchor(owner);
  return `${anchor === '-' ? owner.name || '(array)' : anchor}[]`;
}

/** What holds an object: a named edge from its dominator, else a container. */
function anchorOf(node: IHeapNode): string {
  const dom = node.dominatorNode;
  if (dom != null) {
    for (const e of node.referrers) {
      if (e.fromNode.id === dom.id && isNamedEdge(e)) return heldByAnchor(node);
    }
  }
  return containerLabel(node) ?? heldByAnchor(node);
}

export interface StringFamily {
  key: string;
  count: number;
  /** Self bytes of the family's flat strings. */
  bytes: number;
  exampleId: number;
  examplePreview: string;
  /** Top holders with how many sampled strings each holds. */
  holders: Array<{label: string; count: number}>;
  /** Strings whose holder was looked up (all, or an even sample). */
  sampled: number;
}

export interface StringFamilyCensus {
  families: StringFamily[];
  /** Families at or over the threshold, before the row cap. */
  qualifying: number;
  threshold: number;
  totalBytes: number;
  sourceCount: number;
  sourceBytes: number;
}

const HOLDER_SAMPLE = 2000;

/**
 * Node indexes of script source text: the `source` edge of a V8 Script, which
 * the snapshot names by its URL (`(code)` type) or `system / Script`.
 */
function scriptSourceStrings(snapshot: IHeapSnapshot): Set<number> {
  const out = new Set<number>();
  snapshot.nodes.forEach(node => {
    if (node.type !== 'code' && !node.name.startsWith('system / Script'))
      return;
    for (const e of node.references) {
      if (e.name_or_index === 'source' && e.toNode.isString)
        out.add(e.toNode.nodeIndex);
    }
  });
  return out;
}

/**
 * One pass over the nodes. Bytes are the SELF size of flat strings only: a
 * cons or sliced string is a small wrapper over flat strings that are counted
 * on their own, so no byte is counted twice. Script source text is left out
 * (it is the loaded code, reported by `memlab_script_census`) and counted
 * separately.
 */
export function stringFamilyCensus(
  snapshot: IHeapSnapshot,
  opts: {
    minBytes?: number;
    minHeapShare?: number;
    limit?: number;
    /** False on a light load, which has no dominators to name holders by. */
    holders?: boolean;
  } = {},
): StringFamilyCensus {
  const sources = scriptSourceStrings(snapshot);
  const groups = new Map<
    string,
    {count: number; bytes: number; top: IHeapNode; members: number[]}
  >();
  let totalBytes = 0;
  let sourceCount = 0;
  let sourceBytes = 0;
  snapshot.nodes.forEach(node => {
    totalBytes += node.self_size;
    if (node.type !== 'string' || node.id <= 3) return;
    if (sources.has(node.nodeIndex)) {
      sourceCount++;
      sourceBytes += node.self_size;
      return;
    }
    const key = stringFamilyKey(node.name);
    const g = groups.get(key);
    if (g == null) {
      groups.set(key, {
        count: 1,
        bytes: node.self_size,
        top: node,
        members: [node.nodeIndex],
      });
      return;
    }
    g.count++;
    g.bytes += node.self_size;
    g.members.push(node.nodeIndex);
    if (node.self_size > g.top.self_size) g.top = node;
  });
  const minBytes = opts.minBytes ?? 1024 * 1024;
  const share = opts.minHeapShare ?? 0.005;
  // At or over minBytes, or over the heap share when that is smaller; a
  // share of 0 makes minBytes the whole rule.
  const threshold =
    share > 0 ? Math.min(minBytes, Math.ceil(totalBytes * share)) : minBytes;
  const qualifying = [...groups.entries()]
    .filter(([, g]) => g.bytes >= threshold)
    .sort((a, b) => b[1].bytes - a[1].bytes);
  const families = qualifying.slice(0, opts.limit ?? 8).map(([key, g]) => {
    const sampled =
      opts.holders === false ? 0 : Math.min(g.members.length, HOLDER_SAMPLE);
    const counts = new Map<string, number>();
    for (let k = 0; k < sampled; k++) {
      const at = Math.floor((k * g.members.length) / sampled);
      const n = snapshot.nodes.get(g.members[at]);
      if (n == null) continue;
      const label = stringHolderLabel(n);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const holders = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([label, count]) => ({label, count}));
    return {
      key,
      count: g.count,
      bytes: g.bytes,
      exampleId: g.top.id,
      examplePreview:
        g.top.name.length > 40 ? `${g.top.name.slice(0, 40)}…` : g.top.name,
      holders,
      sampled,
    };
  });
  return {
    families,
    qualifying: qualifying.length,
    threshold,
    totalBytes,
    sourceCount,
    sourceBytes,
  };
}

/** The markdown section, or no lines when no family reaches the threshold. */
export function formatStringFamilies(census: StringFamilyCensus): string[] {
  const {families} = census;
  if (families.length === 0) return [];
  const rows = families.map(f => {
    const pct = census.totalBytes > 0 ? (f.bytes / census.totalBytes) * 100 : 0;
    const holders = f.holders
      .map(h => `${sanitizeForTable(h.label)} ×${formatNumber(h.count)}`)
      .join('; ');
    return [
      `\`${sanitizeForTable(f.key).replace(/`/g, "'")}\``,
      formatNumber(f.count),
      formatBytes(f.bytes),
      `${pct.toFixed(1)}%`,
      `@${f.exampleId} ${sanitizeForTable(f.examplePreview)}`,
      f.sampled === 0
        ? 'n/a (light load)'
        : f.sampled < f.count
          ? `${holders} (of ${formatNumber(f.sampled)} sampled)`
          : holders,
    ];
  });
  const more =
    census.qualifying > families.length
      ? ` ${formatNumber(census.qualifying - families.length)} more ` +
        'families qualify.'
      : '';
  const src =
    census.sourceCount > 0
      ? ' Script source text is excluded ' +
        `(${formatNumber(census.sourceCount)} strings, ${formatBytes(census.sourceBytes)}; see ` +
        '`memlab_script_census`).'
      : '';
  return [
    `## String Families (≥ ${formatBytes(census.threshold)}` +
      `${census.sourceCount > 0 ? '; script source excluded' : ''})`,
    '',
    markdownTable(
      [
        'Family (digits → #)',
        'Strings',
        'Self bytes',
        '% heap',
        'Largest',
        'Top holders',
      ],
      rows,
      new Set([1, 2, 3]),
    ),
    '',
    `_Strings grouped by their first ${FAMILY_PREFIX_LEN} chars with digits ` +
      'masked (`data:` URLs by mime). Bytes are flat-string self sizes ' +
      '(cons/sliced wrappers not counted, so nothing is counted twice); ' +
      `freeing a family frees at most that.${src}${more} Drill in: ` +
      '`memlab_get_referrers` on the example id._',
    '',
  ];
}
