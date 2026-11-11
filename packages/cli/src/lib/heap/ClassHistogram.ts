/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapSnapshot} from '@memlab/core';

export type ClassKey = {
  /** Class name as displayed, after normalization. */
  name: string;
  /** Heap node type: `object`, `closure`, `string`, `native`, ... */
  type: string;
};

export type ClassRow = ClassKey & {
  count: number;
  selfSize: number;
};

export type ClassHistogram = {
  rows: ClassRow[];
  /** Nodes counted, after the filters. */
  totalCount: number;
  /** Self size of the counted nodes, after the filters. */
  totalSelfSize: number;
};

export type ClassHistogramOptions = {
  /** Only count classes whose name matches. */
  namePattern?: RegExp | null;
};

// The name of a node of these types is its value, not a class, so every
// value would otherwise be its own row.
const VALUE_NAMED_TYPES = new Set([
  'string',
  'concatenated string',
  'sliced string',
  'regexp',
]);

/**
 * The class a heap node is counted under. Value-named nodes (strings,
 * regexps) and unnamed nodes (anonymous closures, internal arrays) are
 * grouped by type, and the per-instance ` @<id>` suffix V8 adds
 * to names such as `system / Context / scope @1234` is dropped, so that those
 * instances form one class.
 */
export function getClassKey(node: {type: string; name: string}): ClassKey {
  if (VALUE_NAMED_TYPES.has(node.type) || node.name === '') {
    return {name: `(${node.type})`, type: node.type};
  }
  return {name: node.name.replace(/ @\d+$/, ''), type: node.type};
}

/**
 * Count and self size per class, in one pass over the nodes. Needs no
 * dominator tree, so the snapshot can be loaded without one.
 */
export function buildClassHistogram(
  snapshot: IHeapSnapshot,
  options: ClassHistogramOptions = {},
): ClassHistogram {
  const pattern = options.namePattern ?? null;
  const rows = new Map<string, ClassRow>();
  let totalCount = 0;
  let totalSelfSize = 0;
  snapshot.nodes.forEach(node => {
    // ids 1-3 are the synthetic roots V8 adds to every snapshot
    if (node.id <= 3) {
      return;
    }
    const key = getClassKey(node);
    if (pattern != null && !pattern.test(key.name)) {
      return;
    }
    totalCount++;
    totalSelfSize += node.self_size;
    const id = `${key.type}\u0000${key.name}`;
    const row = rows.get(id);
    if (row != null) {
      row.count++;
      row.selfSize += node.self_size;
    } else {
      rows.set(id, {...key, count: 1, selfSize: node.self_size});
    }
  });
  return {
    rows: [...rows.values()].sort(compareRows),
    totalCount,
    totalSelfSize,
  };
}

/** Largest self size first; ties by count, then by name. */
function compareRows(a: ClassRow, b: ClassRow): number {
  return (
    b.selfSize - a.selfSize ||
    b.count - a.count ||
    a.name.localeCompare(b.name) ||
    a.type.localeCompare(b.type)
  );
}

/**
 * Parse a user-supplied class name pattern: a case-insensitive regular
 * expression, or the literal text when it is not a valid one.
 */
export function parseNamePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}
