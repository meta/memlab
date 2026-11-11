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

/** Owner of an object reached from no realm (engine internals). */
export const UNATTRIBUTED = -1;
/** Owner of an object reached from more than one realm. */
export const SHARED = -2;

export type NativeContextInfo = {
  /** Node index of the NativeContext. */
  ordinal: number;
  id: number;
  /** The realm's tag, usually its URL, or '' when V8 recorded none. */
  label: string;
  detached: boolean;
  /** Self size of every object this realm alone reaches. */
  ownedSize: number;
  ownedCount: number;
};

export type NativeContextAttribution = {
  /** Owner per node index: a NativeContext node index, SHARED or UNATTRIBUTED. */
  owner: Int32Array;
  contexts: NativeContextInfo[];
  sharedSize: number;
  sharedCount: number;
  unattributedSize: number;
  unattributedCount: number;
};

const PREFIXES = ['system / NativeContext', 'Detached system / NativeContext'];

export function isNativeContext(name: string): boolean {
  return PREFIXES.some(p => name === p || name.startsWith(`${p} / `));
}

function contextLabel(name: string): string {
  for (const p of PREFIXES) {
    if (name.startsWith(`${p} / `)) {
      return name.slice(p.length + 3);
    }
  }
  return '';
}

/**
 * Which JavaScript realm (V8 NativeContext: the page, an iframe, an
 * extension's isolated world, a Node.js `vm` context) owns each object.
 *
 * 1. Pin what the heap states outright: every JS object points at its map,
 *    every map at its meta-map, and each realm has its own meta-map with a
 *    `native_context` edge, so object -> map -> meta-map -> NativeContext
 *    names the owner of every object with a realm-specific map.
 * 2. Spread ownership along strong edges from the pinned objects. An object
 *    reached from two realms is SHARED; one that no realm reaches is
 *    UNATTRIBUTED.
 */
export function attributeNativeContexts(
  snapshot: IHeapSnapshot,
): NativeContextAttribution {
  const count = snapshot.nodes.length;
  const owner = new Int32Array(count).fill(UNATTRIBUTED);
  const fixed = new Uint8Array(count);
  const mapOf = new Int32Array(count).fill(-1);
  const realmOf = new Int32Array(count).fill(-1);
  const contextOrdinals: number[] = [];

  snapshot.nodes.forEach((node: IHeapNode) => {
    const idx = node.nodeIndex;
    if (isNativeContext(node.name)) {
      contextOrdinals.push(idx);
    }
    node.forEachReference((edge: IHeapEdge) => {
      if (edge.type !== 'internal') {
        return undefined;
      }
      if (edge.name_or_index === 'map' && mapOf[idx] < 0) {
        mapOf[idx] = edge.toNode.nodeIndex;
      } else if (
        edge.name_or_index === 'native_context' &&
        realmOf[idx] < 0 &&
        isNativeContext(edge.toNode.name)
      ) {
        realmOf[idx] = edge.toNode.nodeIndex;
      }
      return undefined;
    });
  });

  const queue: number[] = [];
  for (const idx of contextOrdinals) {
    owner[idx] = idx;
    fixed[idx] = 1;
  }
  for (let idx = 0; idx < count; ++idx) {
    if (fixed[idx]) {
      queue.push(idx);
      continue;
    }
    const map = mapOf[idx];
    const meta = map >= 0 ? mapOf[map] : -1;
    const realm = meta >= 0 ? realmOf[meta] : -1;
    if (realm >= 0) {
      owner[idx] = realm;
      fixed[idx] = 1;
      queue.push(idx);
    }
  }

  // Breadth-first from the pinned objects. A node whose owner changes (first
  // reached, or reached from a second realm) is queued again so the change
  // reaches what it holds; owners only move towards SHARED, so this ends.
  for (let head = 0; head < queue.length; ++head) {
    const idx = queue[head];
    const from = owner[idx];
    const node = snapshot.nodes.get(idx);
    if (node == null) {
      continue;
    }
    node.forEachReference((edge: IHeapEdge) => {
      if (edge.type === 'weak' || edge.type === 'shortcut') {
        return undefined;
      }
      const child = edge.toNode.nodeIndex;
      if (child === idx || fixed[child]) {
        return undefined;
      }
      const cur = owner[child];
      const next = cur === UNATTRIBUTED ? from : cur === from ? cur : SHARED;
      if (next !== cur) {
        owner[child] = next;
        queue.push(child);
      }
      return undefined;
    });
  }

  const infoByOrdinal = new Map<number, NativeContextInfo>();
  const contexts = contextOrdinals.map(idx => {
    const node = snapshot.nodes.get(idx) as IHeapNode;
    const info: NativeContextInfo = {
      ordinal: idx,
      id: node.id,
      label: contextLabel(node.name),
      detached: node.name.startsWith('Detached '),
      ownedSize: 0,
      ownedCount: 0,
    };
    infoByOrdinal.set(idx, info);
    return info;
  });
  const result: NativeContextAttribution = {
    owner,
    contexts,
    sharedSize: 0,
    sharedCount: 0,
    unattributedSize: 0,
    unattributedCount: 0,
  };
  snapshot.nodes.forEach((node: IHeapNode) => {
    const o = owner[node.nodeIndex];
    if (o === SHARED) {
      result.sharedSize += node.self_size;
      result.sharedCount++;
    } else if (o === UNATTRIBUTED) {
      result.unattributedSize += node.self_size;
      result.unattributedCount++;
    } else {
      const info = infoByOrdinal.get(o);
      if (info != null) {
        info.ownedSize += node.self_size;
        info.ownedCount++;
      }
    }
  });
  contexts.sort((a, b) => b.ownedSize - a.ownedSize || a.id - b.id);
  return result;
}

/**
 * The contexts to list: the top `top` by owned size, plus every detached
 * one, which is the row a leak investigation needs even when it is small.
 */
export function selectContexts(
  contexts: NativeContextInfo[],
  top: number,
): NativeContextInfo[] {
  return contexts.filter((c, i) => i < top || c.detached);
}
