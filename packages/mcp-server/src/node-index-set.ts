/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * A set of heap nodes, keyed by node index, for whole-graph walks.
 *
 * V8 caps a `Set` or `Map` at 2^24 (~16.7M) entries, so a visited set keyed
 * per node throws "Set maximum size exceeded" on larger heaps. One byte per
 * node has no cap and is smaller than a `Set` from a few thousand entries up.
 */
export class NodeIndexSet {
  private readonly bits: Uint8Array;
  private count = 0;

  constructor(nodeCount: number) {
    this.bits = new Uint8Array(nodeCount);
  }

  get size(): number {
    return this.count;
  }

  has(node: {nodeIndex: number}): boolean {
    return this.bits[node.nodeIndex] === 1;
  }

  hasIndex(index: number): boolean {
    return this.bits[index] === 1;
  }

  /** Returns true when the node was not in the set before. */
  add(node: {nodeIndex: number}): boolean {
    return this.addIndex(node.nodeIndex);
  }

  addIndex(index: number): boolean {
    if (this.bits[index] === 1) return false;
    this.bits[index] = 1;
    this.count++;
    return true;
  }

  /** Node indexes in ascending order. */
  *indexes(): IterableIterator<number> {
    const bits = this.bits;
    for (let i = 0; i < bits.length; i++) if (bits[i] === 1) yield i;
  }
}
