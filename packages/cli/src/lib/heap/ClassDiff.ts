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
import type {ClassHistogram, ClassKey} from './ClassHistogram';

import {NumericSet} from '@memlab/core';
import {getClassKey} from './ClassHistogram';

export type ClassDiffRow = ClassKey & {
  baselineCount: number;
  targetCount: number;
  countDelta: number;
  baselineSelfSize: number;
  targetSelfSize: number;
  selfSizeDelta: number;
  /**
   * Objects of the class in the target that did not exist in the baseline.
   * Only set when both snapshots come from one JS heap, and never for
   * native classes.
   */
  newCount?: number;
  newSelfSize?: number;
};

function rowId(key: ClassKey): string {
  return `${key.type}\u0000${key.name}`;
}

/**
 * Per-class changes from `baseline` to `target`, largest self-size growth
 * first. Classes present on one side only count as zero on the other.
 */
export function diffClassHistograms(
  baseline: ClassHistogram,
  target: ClassHistogram,
): ClassDiffRow[] {
  const rows = new Map<string, ClassDiffRow>();
  const rowFor = (key: ClassKey): ClassDiffRow => {
    const id = rowId(key);
    let row = rows.get(id);
    if (row == null) {
      row = {
        name: key.name,
        type: key.type,
        baselineCount: 0,
        targetCount: 0,
        countDelta: 0,
        baselineSelfSize: 0,
        targetSelfSize: 0,
        selfSizeDelta: 0,
      };
      rows.set(id, row);
    }
    return row;
  };
  for (const r of baseline.rows) {
    const row = rowFor(r);
    row.baselineCount = r.count;
    row.baselineSelfSize = r.selfSize;
  }
  for (const r of target.rows) {
    const row = rowFor(r);
    row.targetCount = r.count;
    row.targetSelfSize = r.selfSize;
  }
  const result = [...rows.values()];
  for (const row of result) {
    row.countDelta = row.targetCount - row.baselineCount;
    row.selfSizeDelta = row.targetSelfSize - row.baselineSelfSize;
  }
  return result.sort(
    (a, b) =>
      b.selfSizeDelta - a.selfSizeDelta ||
      b.countDelta - a.countDelta ||
      a.name.localeCompare(b.name) ||
      a.type.localeCompare(b.type),
  );
}

/**
 * V8 keeps a heap object's id for the object's lifetime, across every
 * snapshot of the same JS heap, but snapshots of different heaps reuse the
 * same ids for unrelated objects. Only V8 heap objects keep their id: a
 * native (C++) object's id comes from its address, which another object can
 * take once it is freed.
 */
function hasStableIdType(type: string): boolean {
  return type !== 'native' && type !== 'synthetic';
}

function hasStableId(node: {id: number; type: string}): boolean {
  return node.id > 3 && hasStableIdType(node.type);
}

export type NodeSample = {id: number; type: string; name: string};

const SAMPLE_SIZE = 20000;
// A surviving object keeps its type and name exactly, while an unrelated
// object under the same id matches only by chance, so the bar can be high.
const MIN_AGREEMENT = 0.98;
const MIN_FOUND = 200;

/** An evenly spaced sample of the nodes whose id is stable. */
export function sampleNodes(snapshot: IHeapSnapshot): NodeSample[] {
  const step = Math.max(1, Math.floor(snapshot.nodes.length / SAMPLE_SIZE));
  const sample: NodeSample[] = [];
  snapshot.nodes.forEach((node, index) => {
    if (index % step === 0 && hasStableId(node)) {
      sample.push({id: node.id, type: node.type, name: node.name});
    }
  });
  return sample;
}

export type HeapIdentity = {
  /** Whether both snapshots were taken from the same JS heap. */
  sameHeap: boolean;
  sampled: number;
  /** Sampled ids that exist in the target. */
  found: number;
  /** Found ids whose node has the same type and name in both. */
  matched: number;
};

/**
 * Tell whether the target was taken from the same JS heap as the sampled
 * baseline: the sampled ids that survive must name the same kind of object.
 */
export function compareHeapIdentity(
  baselineSample: NodeSample[],
  target: IHeapSnapshot,
): HeapIdentity {
  let found = 0;
  let matched = 0;
  for (const s of baselineSample) {
    const node = target.getNodeById(s.id);
    if (node == null) {
      continue;
    }
    found++;
    if (node.type === s.type && node.name === s.name) {
      matched++;
    }
  }
  return {
    sameHeap: found >= MIN_FOUND && matched / found >= MIN_AGREEMENT,
    sampled: baselineSample.length,
    found,
    matched,
  };
}

/** Ids of the baseline's nodes with a stable id. */
export function collectStableIds(snapshot: IHeapSnapshot): NumericSet {
  const ids = new NumericSet();
  snapshot.nodes.forEach(node => {
    if (hasStableId(node)) {
      ids.add(node.id);
    }
  });
  return ids;
}

/**
 * Add, per class, the target objects whose id is not in the baseline: the
 * objects allocated after the baseline was taken that are still alive. Only
 * meaningful when both snapshots come from the same JS heap.
 */
export function addNewObjectCounts(
  rows: ClassDiffRow[],
  target: IHeapSnapshot,
  baselineIds: NumericSet,
  namePattern: RegExp | null = null,
): void {
  const byId = new Map(rows.map(row => [rowId(row), row]));
  // native classes are left without a count: their ids cannot tell
  for (const row of rows) {
    if (hasStableIdType(row.type)) {
      row.newCount = 0;
      row.newSelfSize = 0;
    }
  }
  target.nodes.forEach((node: IHeapNode) => {
    if (!hasStableId(node) || baselineIds.has(node.id)) {
      return;
    }
    const key = getClassKey(node);
    if (namePattern != null && !namePattern.test(key.name)) {
      return;
    }
    const row = byId.get(rowId(key));
    if (row != null) {
      row.newCount = (row.newCount ?? 0) + 1;
      row.newSelfSize = (row.newSelfSize ?? 0) + node.self_size;
    }
  });
}
