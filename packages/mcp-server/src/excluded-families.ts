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
import type {KnownFamily} from './known-families.js';
import {resolveStableKey} from './tools/module-attribution.js';
import {formatBytes, formatNumber} from './utils.js';

/**
 * What a registered dev-only or bounded family retains in one snapshot, so a
 * ladder tool can take it out before computing rates. Found once (a dev-only
 * profiler list, a capped trace buffer), such a family otherwise inflates the
 * Array and number rows of every later round until someone subtracts it by
 * hand.
 */
export interface ExcludedFamily {
  family: KnownFamily;
  /** The root node, or null when the locator did not resolve here. */
  root: number | null;
  /** Retained bytes: the self size of every node the root dominates. */
  bytes: number;
  nodes: number;
  /** Per class key (`keyOf`), the dominated nodes' count and self size. */
  byClass: Map<string, {count: number; selfSize: number}>;
}

export function excludableFamilies(
  families: readonly KnownFamily[],
): KnownFamily[] {
  return families.filter(
    f =>
      (f.kind === 'dev_only' || f.kind === 'bounded_window') &&
      typeof f.locator === 'string' &&
      f.locator !== '',
  );
}

/**
 * Each family's retained set in `snapshot`: the nodes whose dominator chain
 * reaches the family's root. One memoized pass over the dominator tree. A
 * family nested in another is counted under the innermost one only.
 */
export function excludedFamilies(
  snapshot: IHeapSnapshot,
  families: readonly KnownFamily[],
  keyOf: (node: IHeapNode) => string,
  resolve: (
    snapshot: IHeapSnapshot,
    key: string,
  ) => IHeapNode | null = resolveStableKey,
): ExcludedFamily[] {
  const out: ExcludedFamily[] = families.map(family => ({
    family,
    root: null,
    bytes: 0,
    nodes: 0,
    byClass: new Map(),
  }));
  const rootOf = new Map<number, number>();
  families.forEach((f, i) => {
    const node = f.locator != null ? resolve(snapshot, f.locator) : null;
    if (node == null) return;
    out[i].root = node.id;
    rootOf.set(node.nodeIndex, i);
  });
  if (rootOf.size === 0) return out;
  // -2 unknown, -1 outside every family, else the family index.
  const owner = new Int32Array(snapshot.nodes.length).fill(-2);
  const path: number[] = [];
  const ownerOf = (start: IHeapNode): number => {
    path.length = 0;
    let cur: IHeapNode | null = start;
    let answer = -1;
    for (let hops = 0; cur != null && hops < 100_000; hops++) {
      const idx: number = cur.nodeIndex;
      if (owner[idx] !== -2) {
        answer = owner[idx];
        break;
      }
      path.push(idx);
      const fam = rootOf.get(idx);
      if (fam != null) {
        answer = fam;
        break;
      }
      const dom: IHeapNode | null = cur.dominatorNode ?? null;
      if (dom == null || dom.nodeIndex === idx) break;
      cur = dom;
    }
    for (const p of path) owner[p] = answer;
    return answer;
  };
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (node.id <= 3) return;
    const fam = ownerOf(node);
    if (fam < 0) return;
    const row = out[fam];
    row.bytes += node.self_size;
    row.nodes++;
    const key = keyOf(node);
    const c = row.byClass.get(key);
    if (c == null) row.byClass.set(key, {count: 1, selfSize: node.self_size});
    else {
      c.count++;
      c.selfSize += node.self_size;
    }
  });
  return out;
}

/**
 * "Excluded: <family> −X at the last rung" for a per-rung exclusion, with the
 * rungs where a locator did not resolve.
 */
export function excludedSection(
  perRung: ExcludedFamily[][],
  labels: readonly string[],
): string[] {
  if (perRung.length === 0) return [];
  const last = perRung[perRung.length - 1];
  const parts = last.map((f, i) => {
    const first = perRung[0][i];
    const missing = perRung
      .map((r, j) => (r[i].root == null ? (labels[j] ?? `#${j + 1}`) : null))
      .filter((x): x is string => x != null);
    return (
      `\`${f.family.label}\` (${f.family.kind === 'dev_only' ? 'dev only' : 'bounded window'}) ` +
      `−${formatBytes(f.bytes)} / −${formatNumber(f.nodes)} nodes` +
      (perRung.length > 1
        ? ` (was −${formatBytes(first.bytes)} at the first rung)`
        : '') +
      (missing.length > 0
        ? `; ⚠️ \`${f.family.locator}\` did not resolve at ${missing.join(', ')}`
        : '')
    );
  });
  return [
    `> **Excluded before computing rates** (registered families): ${parts.join('; ')}. Every count and rate below is without them.`,
    '',
  ];
}
