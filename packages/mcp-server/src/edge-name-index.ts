/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapEdge, IHeapNode, IHeapSnapshot} from '@memlab/core';

/**
 * Every named edge of a snapshot, grouped by name, built in one pass and kept
 * for the snapshot's lifetime. "Who holds `.x`" and "what is under `.x`" then
 * cost O(answer) for every name, where each new name used to cost a pass over
 * every edge.
 *
 * Element edges and numeric slot names are left out: they are positions, not
 * names, and would make up most of the index.
 */
export interface EdgeNameIndex {
  /**
   * Ids of the nodes holding an edge called `name`, each once, in node order,
   * GC-root nodes (ids 1-3) left out.
   */
  holders(name: string, types?: ReadonlySet<string> | null): number[];
  /** Ids of the nodes an edge called `name` points at, each once. */
  targets(name: string, opts?: {skipHidden?: boolean}): number[];
  readonly names: number;
  readonly edges: number;
}

/** Past this many edges the index would cost more memory than it saves time. */
export const MAX_INDEXED_EDGES = 80_000_000;

const cache = new WeakMap<IHeapSnapshot, EdgeNameIndex | null>();

const isPosition = (name: string | number): boolean =>
  typeof name === 'number' || /^\d+$/.test(name);

/** The index for `snapshot`, or null when it has too many edges to index. */
export function edgeNameIndex(snapshot: IHeapSnapshot): EdgeNameIndex | null {
  if (cache.has(snapshot)) return cache.get(snapshot) ?? null;
  if (snapshot.edges.length > MAX_INDEXED_EDGES) {
    cache.set(snapshot, null);
    return null;
  }
  const nameId = new Map<string, number>();
  const counts: number[] = [];
  const typeId = new Map<string, number>();
  const typeNames: string[] = [];
  const visit = (
    cb: (node: IHeapNode, edge: IHeapEdge, name: number) => void,
  ): void => {
    snapshot.nodes.forEach((node: IHeapNode) => {
      node.forEachReference((edge: IHeapEdge) => {
        if (edge.type === 'element') return;
        const raw = edge.name_or_index;
        if (isPosition(raw)) return;
        let id = nameId.get(raw as string);
        if (id == null) {
          id = counts.length;
          nameId.set(raw as string, id);
          counts.push(0);
        }
        cb(node, edge, id);
      });
    });
  };
  visit((_node, _edge, id) => {
    counts[id]++;
  });
  const start = new Int32Array(counts.length + 1);
  for (let i = 0; i < counts.length; i++) start[i + 1] = start[i] + counts[i];
  const total = start[counts.length];
  const from = new Int32Array(total);
  const to = new Int32Array(total);
  const type = new Uint8Array(total);
  const fill = start.slice(0, counts.length);
  visit((node, edge, id) => {
    const at = fill[id]++;
    from[at] = node.nodeIndex;
    to[at] = edge.toNode.nodeIndex;
    let t = typeId.get(edge.type);
    if (t == null) {
      t = typeNames.length;
      typeId.set(edge.type, t);
      typeNames.push(edge.type);
    }
    type[at] = t;
  });
  const idOf = (idx: number): number => snapshot.nodes.get(idx)?.id ?? -1;
  const index: EdgeNameIndex = {
    names: counts.length,
    edges: total,
    holders(name, types) {
      const id = nameId.get(name);
      if (id == null) return [];
      const out: number[] = [];
      let last = -1;
      for (let i = start[id]; i < start[id + 1]; i++) {
        if (types != null && !types.has(typeNames[type[i]])) continue;
        if (from[i] === last) continue;
        last = from[i];
        const holder = idOf(from[i]);
        if (holder > 3) out.push(holder);
      }
      return out;
    },
    targets(name, opts) {
      const id = nameId.get(name);
      if (id == null) return [];
      const seen = new Set<number>();
      for (let i = start[id]; i < start[id + 1]; i++) {
        if (opts?.skipHidden === true && typeNames[type[i]] === 'hidden') {
          continue;
        }
        const t = idOf(to[i]);
        if (t > 3) seen.add(t);
      }
      return [...seen];
    },
  };
  cache.set(snapshot, index);
  return index;
}

/** True when `name` is one the index covers (not an element position). */
export function isIndexedEdgeName(name: string): boolean {
  return !isPosition(name);
}
