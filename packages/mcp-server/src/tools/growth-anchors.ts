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
import {tickAnalysis} from '../analysis-budget.js';
import {classifyArtifact, isEngineClass} from '../artifact-classes.js';
import {cachedPathLabeler} from '../heap-families.js';
import {recordLead} from '../lead-registry.js';
import {
  formatBytes,
  formatNumber,
  heldByLabel,
  markdownTable,
} from '../utils.js';

export interface AnchorTotals {
  /** New objects counted under this anchor. */
  nodes: number;
  /** Sum of their self sizes: each new byte lands under exactly one anchor. */
  self: number;
  /**
   * Sum of the retained sizes of the TOP-LEVEL new objects (those whose
   * immediate dominator is the anchor itself). Those subtrees are disjoint,
   * so nothing is counted twice.
   */
  retained: number;
}

/**
 * Assign every new object to its growth anchor: the nearest dominator that
 * already existed in the baseline. A new object whose dominator chain climbs
 * to the root through new objects only is anchored at the root.
 *
 * `idom[i]` is the immediate dominator's index (-1 or i itself for none);
 * `counted[i]` is 0 for a new object to leave out of the totals (dev-only or
 * engine code) while still letting the chains above and below it resolve.
 * One pass with path compression, so O(n) however deep the chains are.
 */
export function growthAnchors(input: {
  isNew: Uint8Array;
  counted?: Uint8Array;
  idom: Int32Array;
  self: ArrayLike<number>;
  retained: ArrayLike<number>;
  root: number;
}): {anchor: Int32Array; top: Int32Array; totals: Map<number, AnchorTotals>} {
  const {isNew, counted, idom, self, retained, root} = input;
  const n = isNew.length;
  // anchor[i]: the pre-existing dominator; top[i]: the highest new object on
  // i's chain, the one the anchor dominates directly. -1 for old objects.
  const anchor = new Int32Array(n).fill(-1);
  const top = new Int32Array(n).fill(-1);
  const path: number[] = [];
  for (let i = 0; i < n; i++) {
    if (isNew[i] === 0 || anchor[i] >= 0) continue;
    if ((i & 0xffff) === 0) tickAnalysis();
    let cur = i;
    let found = root;
    let head = -1;
    while (path.length <= n) {
      path.push(cur);
      const d = idom[cur];
      if (d < 0 || d === cur) break; // unreachable or the root: anchor at root
      if (isNew[d] === 0) {
        found = d;
        break;
      }
      if (anchor[d] >= 0) {
        found = anchor[d];
        head = top[d];
        break;
      }
      cur = d;
    }
    if (head < 0) head = cur;
    for (const p of path) {
      anchor[p] = found;
      top[p] = head;
    }
    path.length = 0;
  }
  const totals = new Map<number, AnchorTotals>();
  for (let i = 0; i < n; i++) {
    const a = anchor[i];
    if (a < 0 || (counted != null && counted[i] === 0)) continue;
    let t = totals.get(a);
    if (t == null) {
      t = {nodes: 0, self: 0, retained: 0};
      totals.set(a, t);
    }
    t.nodes++;
    t.self += self[i];
    if (top[i] === i) t.retained += retained[i];
  }
  return {anchor, top, totals};
}

const cut = (s: string, room: number): string =>
  s.length > room ? s.slice(0, room - 1) + '…' : s;

/**
 * `explain_delta({group_by: "anchor"})`: group the objects absent from the
 * baseline (by V8 node id) by their growth anchor in the target, and name
 * each anchor's holder and shortest-path label. Rows sort by new self bytes.
 */
export function renderGrowthAnchors(
  baseline: IHeapSnapshot,
  target: IHeapSnapshot,
  labels: {baseline: string; target: string},
  opts: {
    limit: number;
    minBytes: number;
    reached: Uint8Array | null;
    includeEngine: boolean;
    includeArtifacts: boolean;
  },
): string {
  const n = target.nodes.length;
  const isNew = new Uint8Array(n);
  const counted = new Uint8Array(n);
  const idom = new Int32Array(n).fill(-1);
  const self = new Float64Array(n);
  const retained = new Float64Array(n);
  let root = 0;
  let shared = 0;
  let sampled = 0;
  let sampledSame = 0;
  let engineNodes = 0;
  let engineBytes = 0;
  let devBytes = 0;
  target.nodes.forEach(node => {
    const i = node.nodeIndex;
    if ((i & 0xffff) === 0) tickAnalysis();
    const dom = node.dominatorNode;
    if (dom == null || dom.nodeIndex === i) {
      if (node.type === 'synthetic' && node.name === '') root = i;
    } else {
      idom[i] = dom.nodeIndex;
    }
    self[i] = node.self_size;
    retained[i] = node.retainedSize;
    const old = baseline.getNodeById(node.id);
    if (old != null) {
      // Ids are only comparable within one browser session; a sample of the
      // shared ids tells two unrelated captures apart.
      if (shared++ % 61 === 0) {
        sampled++;
        if (old.type === node.type && old.name === node.name) sampledSame++;
      }
      return;
    }
    isNew[i] = 1;
    if (opts.reached != null && opts.reached[i] === 0) {
      devBytes += node.self_size;
      return;
    }
    if (!opts.includeEngine && isEngineClass(node.name, node.type)) {
      engineNodes++;
      engineBytes += node.self_size;
      return;
    }
    counted[i] = 1;
  });

  const head = `## Growth anchors: "${labels.baseline}" → "${labels.target}"`;
  if (sampled < 20 || sampledSame < 0.8 * sampled) {
    return [
      head,
      '',
      `**Cannot pair these snapshots by node id: ${formatNumber(shared)} of ${formatNumber(n)} target ids exist in the baseline` +
        (sampled > 0
          ? `, and ${Math.round((100 * sampledSame) / sampled)}% of a sample of those name the same object.**`
          : '.**') +
        ' Node ids are comparable only within ONE page session. Use the default `group_by` (dominator class), which does not need them.',
    ].join('\n');
  }

  const {anchor, top, totals} = growthAnchors({
    isNew,
    counted,
    idom,
    self,
    retained,
    root,
  });
  let newNodes = 0;
  let newSelf = 0;
  for (const t of totals.values()) {
    newNodes += t.nodes;
    newSelf += t.self;
  }

  // One row per anchor instance, except the root: new objects that reach a
  // GC root through new objects only would otherwise land in one opaque row,
  // so split them by the shortest-path label of their top-level new object.
  const labeler = cachedPathLabeler(target);
  const nodeAt = (i: number): IHeapNode => target.nodes.get(i) as IHeapNode;
  interface Row extends AnchorTotals {
    anchor: number;
    via: string | null;
    /** Sibling anchors summed into this row (their shared parent). */
    merged: number;
  }
  // Growth spread over several pre-existing siblings (one sample array per
  // component under a `reactRender` object) would split into rows too small
  // to rank; sum siblings under their shared pre-existing, non-global parent.
  const lift = new Map<number, number>();
  const siblings = new Map<number, number[]>();
  for (const a of totals.keys()) {
    const p = idom[a];
    if (a === root || p < 0 || p === root || isNew[p] === 1) continue;
    const pn = nodeAt(p);
    if (pn.type === 'synthetic' || /^Window\b|global/.test(pn.name)) continue;
    const list = siblings.get(p);
    if (list == null) siblings.set(p, [a]);
    else list.push(a);
  }
  for (const [p, list] of siblings) {
    if (list.length > 1) for (const a of list) lift.set(a, p);
  }
  const byKey = new Map<number, Row>();
  for (const [a, t] of totals) {
    if (a === root) continue;
    const key = lift.get(a) ?? a;
    let r = byKey.get(key);
    if (r == null) {
      r = {anchor: key, via: null, merged: 0, ...t};
      byKey.set(key, r);
    } else {
      r.nodes += t.nodes;
      r.self += t.self;
      r.retained += t.retained;
    }
    if (key !== a) r.merged++;
  }
  const candidates: Row[] = [...byKey.values()];
  const viaOf = new Map<number, string>();
  const rootRows = new Map<string, Row>();
  if (totals.has(root)) {
    for (let i = 0; i < n; i++) {
      if (anchor[i] !== root || counted[i] === 0) continue;
      let via = viaOf.get(top[i]);
      if (via == null) {
        via = labeler.labelOf(nodeAt(top[i]));
        viaOf.set(top[i], via);
      }
      let r = rootRows.get(via);
      if (r == null) {
        r = {anchor: root, via, merged: 0, nodes: 0, self: 0, retained: 0};
        rootRows.set(via, r);
      }
      r.nodes++;
      r.self += self[i];
      if (top[i] === i) r.retained += retained[i];
    }
  }
  candidates.push(...rootRows.values());
  candidates.sort((x, y) => y.self - x.self);

  const rows: Row[] = [];
  let artifactRows = 0;
  let artifactBytes = 0;
  for (const r of candidates) {
    if (r.self < opts.minBytes || rows.length >= opts.limit) break;
    if (!opts.includeArtifacts && classifyArtifact(nodeAt(r.anchor).name)) {
      artifactRows++;
      artifactBytes += r.self;
      continue;
    }
    rows.push(r);
  }

  const lines: string[] = [
    head,
    '',
    `**${formatNumber(newNodes)} objects (${formatBytes(newSelf)} self) are absent from the baseline by node id, under ${formatNumber(totals.size)} anchor(s).** An anchor is the nearest dominator that already existed in the baseline.`,
    '',
  ];
  if (rows.length === 0) {
    lines.push(
      `No anchor holds at least ${formatBytes(opts.minBytes)} of new objects. Lower \`min_delta_bytes\`, or use the default \`group_by\`.`,
    );
    return lines.join('\n');
  }

  // Top classes of the new objects, only for the rows shown.
  const rowOf = (i: number): number => {
    const a = anchor[i];
    return a === root
      ? rows.findIndex(r => r.via === viaOf.get(top[i]))
      : rows.findIndex(r => r.anchor === (lift.get(a) ?? a));
  };
  const shownAnchors = new Set(rows.map(r => r.anchor));
  for (const [a, p] of lift) if (shownAnchors.has(p)) shownAnchors.add(a);
  const byRow = rows.map(
    () => new Map<string, {nodes: number; bytes: number}>(),
  );
  target.nodes.forEach(node => {
    const i = node.nodeIndex;
    if (counted[i] === 0 || !shownAnchors.has(anchor[i])) return;
    const r = rowOf(i);
    if (r < 0) return;
    const key = /string/.test(node.type)
      ? '(string)'
      : node.name.length > 0
        ? node.name
        : `(${node.type})`;
    const c = byRow[r].get(key);
    if (c == null) byRow[r].set(key, {nodes: 1, bytes: node.self_size});
    else {
      c.nodes++;
      c.bytes += node.self_size;
    }
  });

  const clean = (s: string, room: number) =>
    cut(s.replace(/\s+/g, ' ').replace(/\|/g, '/'), room);
  const holder = (node: IHeapNode): string => {
    const label = heldByLabel(node, 40);
    if (label !== '-') return label;
    // An internal edge (a Map's table, an array's elements) still names the
    // owner when it comes from the dominator.
    const dom = node.dominatorNode;
    const e = node.referrers.find(r => r.fromNode.nodeIndex === dom?.nodeIndex);
    return e == null
      ? '-'
      : clean(
          `${e.fromNode.name || `(${e.fromNode.type})`}.${e.name_or_index}`,
          40,
        );
  };
  for (const r of rows) {
    const node = nodeAt(r.anchor);
    const atRoot = r.via != null || node.type === 'synthetic';
    recordLead(target, {
      ...(atRoot
        ? {label: r.via ?? '(root)', path: r.via ?? ''}
        : {node, label: holder(node)}),
      bytes: r.self,
      kind: 'growing',
      why: `+${formatNumber(r.nodes)} objects new since ${labels.baseline} (${formatBytes(r.self)} self)`,
      source: 'growth_anchors',
    });
  }
  const table = markdownTable(
    [
      'Anchor',
      'Held by',
      'Path',
      'New objs',
      'New self',
      'Retained',
      'Top new classes',
    ],
    rows.map((r, k) => {
      const node = nodeAt(r.anchor);
      const isRoot = r.via != null || node.type === 'synthetic';
      const classes = [...byRow[k].entries()]
        .sort((x, y) => y[1].bytes - x[1].bytes)
        .slice(0, 3)
        .map(
          ([c, v]) =>
            `${clean(c, 28)} ×${formatNumber(v.nodes)} ${formatBytes(v.bytes)}`,
        )
        .join('; ');
      return [
        isRoot
          ? `**(root)** ${clean(node.name, 24)} @${node.id}`.replace(
              /  +/g,
              ' ',
            )
          : `\`${clean(node.name || `(${node.type})`, 32)}\` @${node.id}` +
            (r.merged > 1 ? ` (${r.merged} anchors)` : ''),
        isRoot ? '(no pre-existing owner)' : holder(node),
        clean(r.via ?? labeler.labelOf(node), 48),
        formatNumber(r.nodes),
        formatBytes(r.self),
        formatBytes(r.retained),
        classes,
      ];
    }),
    new Set([3, 4, 5]),
  );
  lines.push(table, '');
  if (artifactRows > 0) {
    lines.push(
      `> 🧹 ${formatNumber(artifactRows)} anchor(s) with ${formatBytes(artifactBytes)} of new objects suppressed as known measurement artifacts (\`include_artifacts: true\` shows them).`,
      '',
    );
  }
  if (engineNodes > 0) {
    lines.push(
      `> ⚙ ${formatNumber(engineNodes)} new engine objects (compiled code, bytecode, feedback; ${formatBytes(engineBytes)}) are left out of the rows (\`include_engine: true\` counts them).`,
      '',
    );
  }
  if (devBytes > 0) {
    lines.push(
      `> ${formatBytes(devBytes)} of new objects only a dev build holds are left out (\`include_dev: true\` counts them).`,
      '',
    );
  }
  lines.push(
    '_New self sums the self sizes of the new objects, each counted once. Retained sums the retained size of the top-level new objects directly under the anchor; those subtrees are disjoint, but they can include older objects that moved under a new one. A `(N anchors)` row sums sibling anchors under one pre-existing parent. A **(root)** row holds new objects that reach a GC root through new objects only, split by the shortest-path label of the top-level one. New objects under an anchor do not prove a leak: check the anchor (`memlab_retainer_trace`, `memlab_dominator_subtree` on its @id) and a third snapshot to tell filling from unbounded growth._',
  );
  return lines.join('\n');
}
