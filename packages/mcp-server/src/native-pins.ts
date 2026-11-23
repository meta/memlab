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
import {reactionHandlers} from './promise-chains.js';
import {whereOf} from './tools/error-callsites.js';

/**
 * Native (browser) memory that JavaScript alone keeps alive: every native
 * node is charged to its nearest JS dominator. A never-settling promise can
 * pin ~200 KB of Blink objects through its reactions while its own JS side is
 * two small objects, so a JS-heap total or rate does not move when it leaks.
 */
export interface NativePinGroup {
  label: string;
  /** JS objects in the group that pin natives. */
  pinners: number;
  natives: number;
  bytes: number;
  /** Native classes by bytes, largest first. */
  classes: Array<[string, number]>;
  sample: number;
}

const isJs = (n: IHeapNode): boolean =>
  (n.type === 'object' || n.type === 'closure') &&
  !n.name.startsWith('system /');

/** Natives counted: not engine bookkeeping such as script source text. */
const isCountedNative = (n: IHeapNode): boolean =>
  n.type === 'native' && !n.name.startsWith('system /');

/** What a pinner is called: a promise by its first `.then`, a closure by its function. */
function pinnerLabel(snapshot: IHeapSnapshot, n: IHeapNode): string {
  if (n.type === 'closure') {
    return `${n.name || '(anonymous)'} — ${whereOf(snapshot, n)}`;
  }
  if (n.name === 'Promise') {
    const [fn] = reactionHandlers(n, 1);
    return fn != null
      ? `Promise → .then ${fn.name || '(anonymous)'} — ${whereOf(snapshot, fn)}`
      : 'Promise';
  }
  return n.name;
}

export function nativePins(
  snapshot: IHeapSnapshot,
  // Totals only: skips labelling every pinner, for callers that read `total`.
  opts: {totalOnly?: boolean} = {},
): {
  total: number;
  unpinned: number;
  groups: NativePinGroup[];
} {
  // -2 unknown, -1 no JS dominator, else the pinner's node index.
  const owner = new Int32Array(snapshot.nodes.length).fill(-2);
  const path: number[] = [];
  const pinnerOf = (start: IHeapNode): number => {
    path.length = 0;
    let cur: IHeapNode | null = start.dominatorNode ?? null;
    let answer = -1;
    for (let hops = 0; cur != null && hops < 100_000; hops++) {
      const idx: number = cur.nodeIndex;
      if (owner[idx] !== -2) {
        answer = owner[idx];
        break;
      }
      if (isJs(cur)) {
        answer = idx;
        break;
      }
      path.push(idx);
      const dom: IHeapNode | null = cur.dominatorNode ?? null;
      if (dom == null || dom.nodeIndex === idx) break;
      cur = dom;
    }
    for (const p of path) owner[p] = answer;
    return answer;
  };
  const byPinner = new Map<
    number,
    {bytes: number; natives: number; classes: Map<string, number>}
  >();
  let total = 0;
  let unpinned = 0;
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (!isCountedNative(node)) return;
    const p = pinnerOf(node);
    if (p < 0) {
      unpinned += node.self_size;
      return;
    }
    total += node.self_size;
    if (opts.totalOnly === true) return;
    let row = byPinner.get(p);
    if (row == null) {
      row = {bytes: 0, natives: 0, classes: new Map()};
      byPinner.set(p, row);
    }
    row.bytes += node.self_size;
    row.natives++;
    row.classes.set(
      node.name,
      (row.classes.get(node.name) ?? 0) + node.self_size,
    );
  });
  const groups = new Map<
    string,
    {
      pinners: number;
      natives: number;
      bytes: number;
      classes: Map<string, number>;
      sample: number;
      sampleBytes: number;
    }
  >();
  for (const [idx, row] of byPinner) {
    const n = snapshot.nodes.get(idx);
    if (n == null) continue;
    const label = pinnerLabel(snapshot, n);
    let g = groups.get(label);
    if (g == null) {
      g = {
        pinners: 0,
        natives: 0,
        bytes: 0,
        classes: new Map(),
        sample: n.id,
        sampleBytes: 0,
      };
      groups.set(label, g);
    }
    g.pinners++;
    g.natives += row.natives;
    g.bytes += row.bytes;
    for (const [c, b] of row.classes)
      g.classes.set(c, (g.classes.get(c) ?? 0) + b);
    if (row.bytes > g.sampleBytes) {
      g.sampleBytes = row.bytes;
      g.sample = n.id;
    }
  }
  return {
    total,
    unpinned,
    groups: [...groups.entries()]
      .map(([label, g]) => ({
        label,
        pinners: g.pinners,
        natives: g.natives,
        bytes: g.bytes,
        classes: [...g.classes.entries()].sort((a, b) => b[1] - a[1]),
        sample: g.sample,
      }))
      .sort((a, b) => b.bytes - a.bytes),
  };
}
