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

export type SlicedParent = {
  id: number;
  /** Self size of the parent string: what its slices keep alive. */
  size: number;
  sliceCount: number;
  /**
   * Whether every reference to the parent comes from one of its slices, so
   * copying the slices out would free the parent.
   */
  heldOnlyBySlices: boolean;
  /** The start of the parent's text, as recorded in the snapshot. */
  preview: string;
};

export type SlicedStringReport = {
  slicedCount: number;
  slicedSelfSize: number;
  /** Self size of the parents that only slices keep alive. */
  pinnedSize: number;
  parents: SlicedParent[];
};

function getParent(node: IHeapNode): IHeapNode | null {
  for (const edge of node.references) {
    if (`${edge.name_or_index}` === 'parent' && edge.toNode.isString) {
      return edge.toNode;
    }
  }
  return null;
}

function isHeldOnlyBySlices(parent: IHeapNode): boolean {
  let held = true;
  parent.forEachReferrer(edge => {
    if (edge.fromNode.type !== 'sliced string') {
      held = false;
      return {stop: true};
    }
    return undefined;
  });
  return held;
}

/**
 * Sliced strings and the parent strings they keep alive. V8 makes a
 * substring of 13 or more characters a slice of its parent instead of a
 * copy, so a few short substrings of a large string (a parsed response, a
 * file read into memory) keep the whole string alive.
 */
export function findSlicedStringParents(
  snapshot: IHeapSnapshot,
): SlicedStringReport {
  let slicedCount = 0;
  let slicedSelfSize = 0;
  const parents = new Map<number, {node: IHeapNode; parent: SlicedParent}>();
  snapshot.nodes.forEach(node => {
    if (node.type !== 'sliced string') {
      return;
    }
    slicedCount++;
    slicedSelfSize += node.self_size;
    const parent = getParent(node);
    if (parent == null) {
      return;
    }
    let entry = parents.get(parent.id);
    if (entry == null) {
      entry = {
        node: parent,
        parent: {
          id: parent.id,
          size: parent.self_size,
          sliceCount: 0,
          heldOnlyBySlices: false,
          preview: parent.name.slice(0, 200),
        },
      };
      parents.set(parent.id, entry);
    }
    entry.parent.sliceCount++;
  });
  let pinnedSize = 0;
  const result: SlicedParent[] = [];
  for (const {node, parent} of parents.values()) {
    parent.heldOnlyBySlices = isHeldOnlyBySlices(node);
    if (parent.heldOnlyBySlices) {
      pinnedSize += parent.size;
    }
    result.push(parent);
  }
  result.sort((a, b) => b.size - a.size || b.sliceCount - a.sliceCount);
  return {slicedCount, slicedSelfSize, pinnedSize, parents: result};
}
