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
import {recordLead} from '../lead-registry.js';
import {formatBytes, formatNumber, markdownTable} from '../utils.js';

/**
 * Bottom-up population cost: objects grouped by constructor plus property
 * set, ranked by what cutting every instance frees.
 *
 * Top-down tools rank single holders, so a cost spread over thousands of small
 * records that no one object dominates (a wrapper per intercepted function, a
 * record per subscription) never reaches their tables.
 */
export interface ShapeCluster {
  cls: string;
  props: string[];
  count: number;
  self: number;
  /** Retained size of the instances no other instance of the shape dominates. */
  frees: number;
  /** Closure-valued properties per instance, on average. */
  closuresEach: number;
  example: number;
}

const SKIP_NAME = /^(system \/ |\()/;

/** Constructor plus sorted property names, or null for a non-record. */
export function shapeKeyOf(node: IHeapNode): {
  key: string;
  props: string[];
  closures: number;
} | null {
  if (node.type !== 'object' || node.id <= 3) return null;
  if (SKIP_NAME.test(node.name)) return null;
  const props: string[] = [];
  let closures = 0;
  for (const e of node.references) {
    if (e.type !== 'property') continue;
    const name = String(e.name_or_index);
    if (name === '__proto__') continue;
    props.push(name);
    if (e.toNode.type === 'closure') closures++;
  }
  if (props.length === 0) return null;
  props.sort();
  return {key: `${node.name}\u0000${props.join(',')}`, props, closures};
}

/** Instance count and self bytes per shape. */
export function shapeCounts(
  snapshot: IHeapSnapshot,
): Map<
  string,
  {cls: string; props: string[]; count: number; self: number; example: number}
> {
  const out = new Map<
    string,
    {cls: string; props: string[]; count: number; self: number; example: number}
  >();
  snapshot.nodes.forEach((node: IHeapNode) => {
    const k = shapeKeyOf(node);
    if (k == null) return;
    const row = out.get(k.key);
    if (row == null) {
      out.set(k.key, {
        cls: node.name,
        props: k.props,
        count: 1,
        self: node.self_size,
        example: node.id,
      });
    } else {
      row.count++;
      row.self += node.self_size;
    }
  });
  return out;
}

export function shapeText(
  cls: string,
  props: readonly string[],
  width: number,
): string {
  const text = `${cls}{${props.join(', ')}}`;
  return text.length > width ? `${text.slice(0, width - 2)}…}` : text;
}

export function shapeClusters(
  snapshot: IHeapSnapshot,
  opts: {minCount?: number; candidates?: number} = {},
): ShapeCluster[] {
  const minCount = opts.minCount ?? 50;
  const n = snapshot.nodes.length;
  const shapeOf = new Int32Array(n).fill(-1);
  const index = new Map<string, number>();
  const groups: Array<{
    cls: string;
    props: string[];
    count: number;
    self: number;
    upper: number;
    closures: number;
    example: number;
  }> = [];
  snapshot.nodes.forEach((node: IHeapNode) => {
    const shape = shapeKeyOf(node);
    if (shape == null) return;
    const {key, props, closures} = shape;
    let g = index.get(key);
    if (g == null) {
      g = groups.length;
      index.set(key, g);
      groups.push({
        cls: node.name,
        props,
        count: 0,
        self: 0,
        upper: 0,
        closures: 0,
        example: node.id,
      });
    }
    const row = groups[g];
    row.count++;
    row.self += node.self_size;
    row.upper += node.retainedSize;
    row.closures += closures;
    shapeOf[node.nodeIndex] = g;
  });

  const picked = groups
    .map((g, i) => ({g, i}))
    .filter(({g}) => g.count >= minCount)
    .sort((a, b) => b.g.upper - a.g.upper)
    .slice(0, opts.candidates ?? 60);
  const isCandidate = new Uint8Array(groups.length);
  for (const {i} of picked) isCandidate[i] = 1;
  const frees = new Float64Array(groups.length);

  // Nearest strict dominator-ancestor that is an instance of any picked
  // shape, memoised so the whole pass is O(N). The hop cap only stops a
  // cycle in malformed dominator data: a real chain is at most n long.
  const near = new Int32Array(n).fill(-3);
  const path: number[] = [];
  const nearest = (start: number): number => {
    path.length = 0;
    let cur = start;
    let answer = -1;
    for (let hops = 0; hops <= n; hops++) {
      if (near[cur] !== -3) {
        answer = near[cur];
        break;
      }
      path.push(cur);
      const dom = snapshot.nodes.get(cur)?.dominatorNode;
      if (dom == null || dom.nodeIndex === cur) break;
      const d = dom.nodeIndex;
      if (shapeOf[d] >= 0 && isCandidate[shapeOf[d]]) {
        answer = d;
        break;
      }
      cur = d;
    }
    for (const p of path) near[p] = answer;
    return answer;
  };

  snapshot.nodes.forEach((node: IHeapNode) => {
    const g = shapeOf[node.nodeIndex];
    if (g < 0 || !isCandidate[g]) return;
    let up = nearest(node.nodeIndex);
    while (up >= 0 && shapeOf[up] !== g) up = nearest(up);
    if (up < 0) frees[g] += node.retainedSize;
  });

  return picked
    .map(({g, i}) => ({
      cls: g.cls,
      props: g.props,
      count: g.count,
      self: g.self,
      frees: frees[i],
      closuresEach: g.closures / g.count,
      example: g.example,
    }))
    .sort((a, b) => b.frees - a.frees);
}

function shapeLabel(c: ShapeCluster, width: number): string {
  return shapeText(c.cls, c.props, width);
}

/** The sweep's bottom-up population table. */
export function shapeClustersSection(
  snapshot: IHeapSnapshot,
  limit: number,
): string[] {
  const rows = shapeClusters(snapshot).slice(0, limit);
  if (rows.length === 0) return [];
  for (const c of rows) {
    recordLead(snapshot, {
      label: shapeText(c.cls, c.props, 90),
      ids: [c.example],
      bytes: c.frees,
      kind: 'large',
      why: `shape cluster: ${formatNumber(c.count)} instances, cutting all frees ${formatBytes(c.frees)}`,
      source: 'sweep shapes',
      check: `memlab_what_if({shape:${JSON.stringify(c.props.slice(0, 12))}})`,
    });
  }
  const top = rows[0];
  return [
    `### Shape clusters by what cutting every instance frees (≥ 50 instances) → \`memlab_what_if({shape})\``,
    '',
    markdownTable(
      [
        'Shape (class{properties})',
        'Count',
        'Each',
        'Cut frees',
        'Closures each',
        'Example',
      ],
      rows.map(c => [
        `\`${shapeLabel(c, 70)}\``,
        formatNumber(c.count),
        formatBytes(Math.round(c.frees / c.count)),
        formatBytes(c.frees),
        c.closuresEach >= 0.05 ? c.closuresEach.toFixed(1) : '0',
        `@${c.example}`,
      ]),
      new Set([1, 2, 3, 4]),
    ),
    '',
    `_Bottom-up: a cost spread over many small instances that no single holder dominates (a wrapper per intercepted function, a record per subscription) appears here and not in section 1. "Cut frees" counts each instance once, under the outermost instance of its shape. Size one with \`memlab_what_if({shape: ${JSON.stringify(top.props.slice(0, 12))}})\`, which also matches objects with extra properties._`,
    '',
  ];
}
