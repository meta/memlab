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

export type ObjectQuery = {
  /** Class (node) name pattern. */
  namePattern?: RegExp | null;
  /** Exact heap node type: `object`, `closure`, `native`, ... */
  nodeType?: string | null;
  minRetainedSize?: number;
  /** Only detached objects (DOM elements, React fibers). */
  detachedOnly?: boolean;
};

export type FoundObject = {
  id: number;
  name: string;
  type: string;
  selfSize: number;
  retainedSize: number;
  detached: boolean;
};

export type FindObjectsResult = {
  /** Objects that match, before `limit` is applied. */
  matchCount: number;
  /** The largest matches by retained size, at most `limit`. */
  objects: FoundObject[];
};

const UNIT_BYTES: Record<string, number> = {
  '': 1,
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
};

/**
 * Parse a size such as `4096`, `500KB`, `1.5MB` or `2GB` into bytes. Units
 * are powers of 1024, as in the sizes memlab prints. Returns null when the
 * text is not a size.
 */
export function parseSize(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(text);
  if (m == null) {
    return null;
  }
  const unit = UNIT_BYTES[m[2].toLowerCase()];
  return unit == null ? null : Math.round(Number(m[1]) * unit);
}

function compareFound(a: FoundObject, b: FoundObject): number {
  return (
    b.retainedSize - a.retainedSize || b.selfSize - a.selfSize || a.id - b.id
  );
}

/**
 * Objects matching every filter of `query`, largest retained size first.
 * Needs retained sizes, so the snapshot must have its dominator tree. Only
 * the top `limit` matches are kept while scanning, so a broad query on a
 * large heap does not hold every match in memory.
 */
export function findObjects(
  snapshot: IHeapSnapshot,
  query: ObjectQuery,
  limit: number,
): FindObjectsResult {
  const minRetained = query.minRetainedSize ?? 0;
  const pattern = query.namePattern ?? null;
  const top: FoundObject[] = [];
  let matchCount = 0;
  snapshot.nodes.forEach(node => {
    // ids 1-3 are the synthetic roots V8 adds to every snapshot
    if (node.id <= 3 || node.retainedSize < minRetained) {
      return;
    }
    if (query.nodeType != null && node.type !== query.nodeType) {
      return;
    }
    if (query.detachedOnly === true && !node.is_detached) {
      return;
    }
    if (pattern != null && !pattern.test(node.name)) {
      return;
    }
    matchCount++;
    if (
      top.length === limit &&
      node.retainedSize < top[limit - 1].retainedSize
    ) {
      return;
    }
    const found: FoundObject = {
      id: node.id,
      name: node.name,
      type: node.type,
      selfSize: node.self_size,
      retainedSize: node.retainedSize,
      detached: node.is_detached,
    };
    if (top.length === limit && compareFound(found, top[limit - 1]) >= 0) {
      return;
    }
    let i = top.length;
    while (i > 0 && compareFound(found, top[i - 1]) < 0) {
      i--;
    }
    top.splice(i, 0, found);
    if (top.length > limit) {
      top.pop();
    }
  });
  return {matchCount, objects: top};
}
