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

import {getClassKey} from './ClassHistogram';

export type WeakRefHolder = {
  /** `{key1, key2}` for an object holder, else the holder's class name. */
  holder: string;
  total: number;
  empty: number;
  /** One holder object, to inspect with `memlab view-heap` or `trace`. */
  exampleId: number;
};

export type WeakRefCensus = {
  total: number;
  empty: number;
  holders: WeakRefHolder[];
};

const MAX_SHAPE_KEYS = 8;

/**
 * A WeakRef object, not `WeakRef.prototype`: both are named `WeakRef`, but
 * only an instance has the prototype as its `__proto__`.
 */
export function isWeakRefInstance(node: IHeapNode): boolean {
  if (node.type !== 'object' || node.name !== 'WeakRef') {
    return false;
  }
  const proto = node.getReferenceNode('__proto__', 'property');
  return proto != null && proto.name === 'WeakRef';
}

/**
 * Whether the WeakRef's target has been collected. A live WeakRef has a weak
 * `target` edge to its target; a cleared one has none.
 */
export function isEmptyWeakRef(node: IHeapNode): boolean {
  return node.findAnyReference(e => e.type === 'weak') == null;
}

function describeHolder(holder: IHeapNode): string {
  const keys: string[] = [];
  for (const edge of holder.references) {
    if (edge.type === 'property' && edge.name_or_index !== '__proto__') {
      keys.push(`${edge.name_or_index}`);
    }
  }
  if (keys.length === 0) {
    return getClassKey(holder).name;
  }
  const shown = keys.sort().slice(0, MAX_SHAPE_KEYS);
  const more = keys.length > MAX_SHAPE_KEYS ? ', ...' : '';
  return `{${shown.join(', ')}${more}}`;
}

function findHolder(node: IHeapNode): IHeapNode | null {
  let holder: IHeapNode | null = null;
  node.forEachReferrer(edge => {
    const from = edge.fromNode;
    if (from.id <= 3 || edge.type === 'weak') {
      return undefined;
    }
    holder = from;
    return {stop: true};
  });
  return holder;
}

/**
 * Every WeakRef in the heap, split live vs empty and grouped by what holds
 * it. A holder whose WeakRefs are mostly empty is a collection that keeps an
 * entry after its target is gone, so it grows without bound even though
 * each target is collected on time.
 */
export function censusWeakRefs(snapshot: IHeapSnapshot): WeakRefCensus {
  let total = 0;
  let empty = 0;
  const holders = new Map<string, WeakRefHolder>();
  snapshot.nodes.forEach(node => {
    if (!isWeakRefInstance(node)) {
      return;
    }
    total++;
    const isEmpty = isEmptyWeakRef(node);
    if (isEmpty) {
      empty++;
    }
    const holderNode = findHolder(node);
    const holder = holderNode != null ? describeHolder(holderNode) : '(none)';
    let row = holders.get(holder);
    if (row == null) {
      row = {holder, total: 0, empty: 0, exampleId: holderNode?.id ?? 0};
      holders.set(holder, row);
    }
    row.total++;
    if (isEmpty) {
      row.empty++;
    }
  });
  return {
    total,
    empty,
    holders: [...holders.values()].sort(
      (a, b) =>
        b.empty - a.empty ||
        b.total - a.total ||
        a.holder.localeCompare(b.holder),
    ),
  };
}
