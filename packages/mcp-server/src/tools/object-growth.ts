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
import {
  formatBytes,
  formatNumber,
  heldByLabel,
  markdownTable,
} from '../utils.js';
import {countChainLinks} from './chain-walk.js';
import {cachedModuleScopes} from './module-attribution.js';
import {moduleOfScope} from '../module-registry.js';

/**
 * Same-id object growth for `memlab_collection_diff({include_objects})`. Node
 * ids are stable across captures of one page session, so an id whose edge
 * count or retained size grows at every rung is one growing object, even when
 * it is no Map/Set/Array the census names: a record buffer on a plugin object,
 * or a linked list whose head is stable while its tail grows.
 */

// JS types whose identity carries meaning. Strings, numbers and code are left
// out (their edge counts do not grow), and so are Blink natives, whose growth
// between captures is mostly style and layout caches.
const TRACKED_TYPES = new Set(['object', 'closure', 'array', 'hidden']);
const MISSING = 0xffffffff;
export const OBJECT_ROW_CAP = 40;
// A Map/Set/WeakMap keeps its entries on its `table`, not on itself, so the
// table's edges count as the collection's, and the table itself is not a row.
// (Arrays and objects report their elements and properties on themselves too,
// so their stores would count twice.)
const BACKING_EDGE = 'table';

/** Not a row: engine internals and nameless or parenthesised backing stores. */
function isTracked(n: IHeapNode): boolean {
  if (!TRACKED_TYPES.has(n.type)) return false;
  const name = n.name;
  if (name === '' || name.startsWith('(')) return false;
  return !name.startsWith('system /') || name === 'system / Context';
}

/** FNV-1a of a class name: enough to tell a reused id from the same object. */
function nameHash(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  }
  return h >>> 0;
}

/** Outgoing edges, counting a collection's `table` entries. */
export function edgeCount(n: IHeapNode): number {
  let count = n.edge_count;
  n.forEachReference(e => {
    if (e.type === 'internal' && e.name_or_index === BACKING_EDGE) {
      count += e.toNode.edge_count;
    }
  });
  return count;
}

const NEXT_LIKE = /next|prev/i;
// A list holder grows by a few hundred bytes per appended link while its edge
// count stays flat, so it qualifies at this share of the retained threshold
// when it holds a `next`-like chain of at least `minEdges` links.
const CHAIN_FRACTION = 0.25;
const MAX_RENAMED_SHARE = 0.05;

export interface GrowthThresholds {
  minEdges: number;
  minRetained: number;
}

/**
 * Whether one object's per-rung series qualifies: a metric that grew at EVERY
 * rung, by its threshold from the first rung to the last. A metric flat on one
 * step is not counted: a one-off jump is usually a lazy init or a dominator
 * re-attribution, not accumulation.
 */
export function classifyGrowth(
  edges: number[],
  retained: number[],
  t: GrowthThresholds,
): {byEdges: boolean; byRetained: boolean; chainBar: boolean} {
  const mono = (s: number[]) => s.every((v, i) => i === 0 || v > s[i - 1]);
  const last = edges.length - 1;
  const rGrow = mono(retained) ? retained[last] - retained[0] : 0;
  return {
    byEdges: mono(edges) && edges[last] - edges[0] >= t.minEdges,
    byRetained: rGrow >= t.minRetained,
    chainBar: rGrow >= t.minRetained * CHAIN_FRACTION,
  };
}

/**
 * Where a node's `next`/`prev`-named chain to objects of the same class starts:
 * the node itself or a child it holds (`via`), preferring a `next` edge.
 */
export function findChain(
  node: IHeapNode,
): {head: IHeapNode; via: string | null; next: string} | null {
  const selfLink = (n: IHeapNode): string | null => {
    let found: string | null = null;
    for (const e of n.references) {
      const name = String(e.name_or_index);
      if (!NEXT_LIKE.test(name) || e.toNode.name !== n.name) continue;
      if (e.toNode.id === n.id) continue;
      if (/next/i.test(name)) return name;
      found = found ?? name;
    }
    return found;
  };
  const own = selfLink(node);
  if (own != null) return {head: node, via: null, next: own};
  for (const e of node.references) {
    if (e.type !== 'property' && e.type !== 'context') continue;
    const next = selfLink(e.toNode);
    if (next != null) {
      return {head: e.toNode, via: String(e.name_or_index), next};
    }
  }
  return null;
}

/** `.$5 → .nextRoute ×1,362` for a node holding a chain of 3+ links. */
function chainLabel(node: IHeapNode): {label: string; links: number} | null {
  const ch = findChain(node);
  if (ch == null) return null;
  const w = countChainLinks(ch.head, [ch.next], 100000);
  if (w.links < 3) return null;
  const via = ch.via != null ? `.${ch.via} ` : '';
  const more = `${w.truncated ? '+' : ''}${w.cyclic ? ' (cyclic)' : ''}`;
  return {
    label: `${via}→ .${ch.next} ×${formatNumber(w.links)}${more}`,
    links: w.links,
  };
}

export interface ObjectGrowthRow {
  id: number;
  name: string;
  holder: string;
  edges: number[];
  retained: number[];
  chain: string | null;
}

/**
 * Per-id series, one graph at a time: rung 0 seeds sorted ids, later rungs fill
 * a column by binary search and drop ids that vanish or stop growing.
 */
export class ObjectGrowthTracker {
  private ids = new Float64Array(0);
  private names = new Uint32Array(0);
  private edges: Uint32Array[] = [];
  private retained: Float64Array[] = [];
  // Highest share, on any later rung, of matched ids whose class name differs.
  // In one page session an id is one object; separate sessions reuse ids.
  mismatchShare = 0;

  private indexOf(id: number): number {
    const ids = this.ids;
    let lo = 0;
    let hi = ids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ids[mid] < id) lo = mid + 1;
      else if (ids[mid] > id) hi = mid - 1;
      else return mid;
    }
    return -1;
  }

  addRung(snapshot: IHeapSnapshot): void {
    if (this.edges.length === 0) {
      const ids: number[] = [];
      const h: number[] = [];
      const e: number[] = [];
      const r: number[] = [];
      snapshot.nodes.forEach((n: IHeapNode) => {
        if (n.id <= 3 || !isTracked(n)) return;
        ids.push(n.id);
        h.push(nameHash(n.name));
        e.push(edgeCount(n));
        r.push(n.retainedSize);
      });
      const order = ids.map((_, i) => i).sort((a, b) => ids[a] - ids[b]);
      this.ids = Float64Array.from(order, i => ids[i]);
      this.names = Uint32Array.from(order, i => h[i]);
      this.edges = [Uint32Array.from(order, i => e[i])];
      this.retained = [Float64Array.from(order, i => r[i])];
      return;
    }
    const ids = this.ids;
    const e = new Uint32Array(ids.length).fill(MISSING);
    const r = new Float64Array(ids.length);
    let matched = 0;
    let renamed = 0;
    snapshot.nodes.forEach((n: IHeapNode) => {
      const i = this.indexOf(n.id);
      if (i < 0) return;
      if (nameHash(n.name) !== this.names[i]) {
        renamed++;
        return;
      }
      matched++;
      e[i] = edgeCount(n);
      r[i] = n.retainedSize;
    });
    if (matched + renamed > 0) {
      const share = renamed / (matched + renamed);
      this.mismatchShare = Math.max(this.mismatchShare, share);
    }
    const pe = this.edges[this.edges.length - 1];
    const pr = this.retained[this.retained.length - 1];
    const keep: number[] = [];
    for (let i = 0; i < ids.length; i++) {
      if (e[i] === MISSING) continue;
      if (e[i] <= pe[i] && r[i] <= pr[i]) continue;
      keep.push(i);
    }
    const pick = <T extends Float64Array | Uint32Array>(a: T): T =>
      a.constructor === Float64Array
        ? (Float64Array.from(keep, i => a[i]) as T)
        : (Uint32Array.from(keep, i => a[i]) as T);
    this.ids = pick(ids);
    this.names = pick(this.names);
    this.edges = [...this.edges, e].map(pick);
    this.retained = [...this.retained, r].map(pick);
  }

  /**
   * Rows from the LAST rung's graph (the one just added), which supplies the
   * holder labels, dominators and chain walks. An object whose retained growth
   * is explained by qualifying objects it dominates is dropped for them.
   */
  finish(
    last: IHeapSnapshot,
    t: GrowthThresholds,
  ): {rows: ObjectGrowthRow[]; total: number; mismatchShare: number} {
    const series = (i: number) => ({
      edges: this.edges.map(c => c[i]),
      retained: this.retained.map(c => c[i]),
    });
    interface Cand {
      node: IHeapNode;
      edges: number[];
      retained: number[];
      chain: string | null;
      byEdges: boolean;
      rGrow: number;
      bar: number;
    }
    const cands = new Map<number, Cand>();
    for (let i = 0; i < this.ids.length; i++) {
      const s = series(i);
      const q = classifyGrowth(s.edges, s.retained, t);
      if (!q.byEdges && !q.byRetained && !q.chainBar) continue;
      const node = last.getNodeById(this.ids[i]);
      if (node == null) continue;
      const chain = q.byEdges || q.byRetained ? null : chainLabel(node);
      if (chain != null && chain.links < t.minEdges) continue;
      if (!q.byEdges && !q.byRetained && chain == null) continue;
      cands.set(node.id, {
        ...s,
        chain: chain?.label ?? null,
        node,
        byEdges: q.byEdges,
        rGrow: s.retained[s.retained.length - 1] - s.retained[0],
        bar: chain != null ? t.minRetained * CHAIN_FRACTION : t.minRetained,
      });
    }
    // Growth each candidate's nearest qualifying dominator-descendants explain.
    const explained = new Map<number, number>();
    for (const c of cands.values()) {
      let a = c.node.dominatorNode;
      for (let hop = 0; a != null && a.id > 3 && hop < 64; hop++) {
        if (cands.has(a.id)) {
          explained.set(
            a.id,
            (explained.get(a.id) ?? 0) + Math.max(0, c.rGrow),
          );
          break;
        }
        a = a.dominatorNode;
      }
    }
    const kept = [...cands.values()].filter(
      c => c.byEdges || c.rGrow - (explained.get(c.node.id) ?? 0) >= c.bar,
    );
    kept.sort((a, b) => b.rGrow - a.rGrow || a.node.id - b.node.id);
    const rows = kept.slice(0, OBJECT_ROW_CAP).map(c => ({
      id: c.node.id,
      name: c.node.name,
      holder: holderOf(last, c.node),
      edges: c.edges,
      retained: c.retained,
      chain: c.chain ?? chainLabel(c.node)?.label ?? null,
    }));
    return {rows, total: kept.length, mismatchShare: this.mismatchShare};
  }
}

/**
 * `heldByLabel`, made findable when it alone is not: a closure variable gets
 * its module (`BrowserToolsInteractionTracingInterop: closure var c`), and a
 * property of a minified or plain `Object` owner gets the owner's own holder
 * (`Object.tracesRecordsProvider ▸ e.mBuff`).
 */
function holderOf(snapshot: IHeapSnapshot, node: IHeapNode): string {
  const label = heldByLabel(node, 40);
  const dom = node.dominatorNode;
  if (dom == null || dom.id <= 3) return label;
  if (label.startsWith('closure var ') && dom.name === 'system / Context') {
    const module =
      cachedModuleScopes(snapshot).get(dom.id) ??
      moduleOfScope(snapshot, dom, true);
    return module != null ? `${module}: ${label}` : label;
  }
  if (/^([\w$]{1,2}|Object)\./.test(label)) {
    const up = heldByLabel(dom, 40);
    if (up !== '-') return `${up} ▸ ${label}`;
  }
  return label;
}

function signedBytes(v: number): string {
  return `${v < 0 ? '-' : '+'}${formatBytes(Math.abs(v))}`;
}

/** The markdown section for `include_objects`, or [] when nothing grew. */
export function formatObjectGrowth(
  rows: ObjectGrowthRow[],
  total: number,
  t: GrowthThresholds,
  mismatchShare = 0,
): string[] {
  const warn =
    mismatchShare > MAX_RENAMED_SHARE
      ? [
          '',
          `**⚠ Same-id objects not listed: ${(mismatchShare * 100).toFixed(1)}% of ids shared between rungs name a different class.** Node ids identify one object only within one page session; these captures look like separate sessions (a reload, another tab or build), so same-id matches would be coincidental.`,
        ]
      : [];
  if (warn.length > 0 || rows.length === 0) return warn;
  const rungs = rows[0].edges.length;
  const arrow = (s: string[]) => s.join(' → ');
  const table = rows.map(r => [
    r.holder,
    r.name.length > 40 ? r.name.slice(0, 39) + '…' : r.name,
    arrow(r.edges.map(formatNumber)),
    arrow(r.retained.map(formatBytes)),
    signedBytes(r.retained[r.retained.length - 1] - r.retained[0]),
    r.chain ?? '',
    `@${r.id}`,
  ]);
  return [
    '',
    `### Same-id objects that grew at every rung (${formatNumber(rows.length)} of ${formatNumber(total)})`,
    '',
    `Objects present on every rung whose outgoing edge count (by ≥${formatNumber(t.minEdges)} in all) or retained size (by ≥${formatBytes(t.minRetained)}) grew at every rung. An object whose growth is explained by a listed object it dominates is omitted. Ids are from the last rung.`,
    '',
    markdownTable(
      [
        'Held by',
        'Class',
        'Edges per rung',
        'Retained per rung',
        'Δ retained',
        'Chain (last rung)',
        'Node',
      ],
      table,
      new Set([4]),
    ),
    '',
    ...(rungs === 2
      ? [
          '_With 2 rungs, a one-off change (a module loaded on first use, a first render) also counts as growth at every rung; a 3+ rung ladder separates accumulation from it._',
        ]
      : []),
    '_Retained growth with a flat edge count can be dominator re-attribution rather than new objects; check the node with `memlab_retainer_trace`, and walk a chain with `memlab_chain_walk` on each rung to confirm its length grows._',
  ];
}
