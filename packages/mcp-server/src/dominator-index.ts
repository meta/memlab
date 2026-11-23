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
import {tickAnalysis} from './analysis-budget.js';

/**
 * Per-node dominator-tree facts, in typed arrays over node indexes.
 *
 * A `Map` keyed by parent id holds one entry per node that dominates anything,
 * and V8 caps a `Map` at 2^24 entries.
 */
export interface HeaviestChildIndex {
  /** Node index of each node's largest dominated child, or -1 for a leaf. */
  heaviest: Int32Array;
  /** How many nodes each node immediately dominates. */
  children: Int32Array;
}

export function heaviestChildIndex(
  snapshot: IHeapSnapshot,
): HeaviestChildIndex {
  const n = snapshot.nodes.length;
  const heaviest = new Int32Array(n).fill(-1);
  const best = new Float64Array(n);
  const children = new Int32Array(n);
  snapshot.nodes.forEach(node => {
    tickAnalysis();
    const dom = node.dominatorNode;
    if (dom == null || dom.nodeIndex === node.nodeIndex) return;
    const d = dom.nodeIndex;
    children[d]++;
    const retained = node.retainedSize;
    if (heaviest[d] < 0 || retained > best[d]) {
      heaviest[d] = node.nodeIndex;
      best[d] = retained;
    }
  });
  return {heaviest, children};
}

/** The `k` largest dominated children of each parent id in `parentIds`. */
export function topDominatedChildren(
  snapshot: IHeapSnapshot,
  parentIds: Iterable<number>,
  k: number,
): Map<number, IHeapNode[]> {
  const out = new Map<number, IHeapNode[]>();
  for (const id of parentIds) out.set(id, []);
  if (out.size === 0) return out;
  snapshot.nodes.forEach(node => {
    tickAnalysis();
    const dom = node.dominatorNode;
    if (dom == null || dom.nodeIndex === node.nodeIndex) return;
    const list = out.get(dom.id);
    if (list == null) return;
    const size = node.retainedSize;
    let at = list.length;
    while (at > 0 && size > list[at - 1].retainedSize) at--;
    if (at >= k) return;
    list.splice(at, 0, node);
    if (list.length > k) list.length = k;
  });
  return out;
}
