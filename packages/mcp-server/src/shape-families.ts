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
import {moduleOfScope, moduleRecords} from './module-registry.js';
import {joinShapeKey, readSidecarAsync} from './snapshot-index.js';

/**
 * `Object +42,008` says nothing a fix can act on: plain objects are every
 * record type the app has. Splitting the growth by property shape, and naming
 * the module that holds each shape's newest instances, is what turns the row
 * into "this record type, held by that module".
 */
export interface ShapeGrowth {
  key: string;
  props: string[];
  counts: Array<number | null>;
  delta: number;
}

export interface ShapeOwner {
  module: string | null;
  /** How many of the sampled newest instances that module holds. */
  votes: number;
  of: number;
}

/** The plain-object shapes that grew most between the first and last rung. */
export async function topObjectShapeGrowth(
  paths: readonly string[],
  limit: number,
): Promise<ShapeGrowth[]> {
  const indexes = await Promise.all(paths.map(p => readSidecarAsync(p)));
  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  if (first == null || last == null) {
    return [];
  }
  const rows: ShapeGrowth[] = [];
  for (const [key, [count]] of Object.entries(last.objectShapes)) {
    const delta = count - (first.objectShapes[key]?.[0] ?? 0);
    if (delta <= 0 || key === '') continue;
    rows.push({
      key,
      props: [],
      counts: indexes.map(ix =>
        ix == null ? null : (ix.objectShapes[key]?.[0] ?? 0),
      ),
      delta,
    });
  }
  rows.sort((a, b) => b.delta - a.delta);
  return rows.slice(0, limit).map(r => ({...r, props: splitKey(r.key)}));
}

function splitKey(key: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < key.length; i++) {
    if (key[i] === '\\' && i + 1 < key.length) cur += key[++i];
    else if (key[i] === ',') {
      out.push(cur);
      cur = '';
    } else cur += key[i];
  }
  out.push(cur);
  return out;
}

/** The same key the sidecar builder gives a plain object. */
export function objectShapeKey(node: IHeapNode): string {
  const props: string[] = [];
  for (const e of node.references) {
    if (e.type !== 'property') continue;
    const name = String(e.name_or_index);
    if (name !== '__proto__') props.push(name);
  }
  props.sort();
  return joinShapeKey(props);
}

/**
 * The module holding `node`, by its shortest retainer path: the first hop
 * that is a module's exports object, or a scope inside a module. Works on a
 * minified build, where modules are known only through their records.
 */
export function ownerModuleOf(
  snapshot: IHeapSnapshot,
  node: IHeapNode,
  exportsOwner: Map<number, string>,
  maxHops = 40,
): string | null {
  let cur: IHeapNode | null = node;
  for (let hop = 0; cur != null && hop < maxHops; hop++) {
    const owner = exportsOwner.get(cur.id);
    if (owner != null) return owner;
    if (cur.name === 'system / Context') {
      const m = moduleOfScope(snapshot, cur);
      if (m != null) return m;
    }
    cur = cur.pathEdge?.fromNode ?? null;
  }
  return null;
}

/** module exports / defaultExport node id -> module name. */
export function exportsOwnerMap(snapshot: IHeapSnapshot): Map<number, string> {
  const out = new Map<number, string>();
  for (const rec of moduleRecords(snapshot).values()) {
    if (rec.exports != null) out.set(rec.exports.id, rec.name);
    if (rec.defaultExport != null) out.set(rec.defaultExport.id, rec.name);
  }
  return out;
}

export function familyOfShape(
  props: readonly string[],
  families: readonly KnownFamily[],
): KnownFamily | null {
  const have = new Set(props);
  return (
    families.find(f => f.shapes.some(want => want.every(p => have.has(p)))) ??
    null
  );
}

export function shapeFamiliesSection(
  rows: readonly ShapeGrowth[],
  owners: ReadonlyMap<string, ShapeOwner>,
  families: readonly KnownFamily[],
  cycles: number | undefined,
  objectDelta: number | null,
): string[] {
  if (rows.length === 0) return [];
  const lines = [
    '### Inside `Object`: the shapes that grew',
    '',
    `The \`Object\` row${objectDelta != null ? ` (${objectDelta >= 0 ? '+' : ''}${objectDelta.toLocaleString()})` : ''} is every plain-object record type at once. Its growth by property shape, with the module holding each shape's newest instances:`,
    '',
    '| Shape | ' +
      rows[0].counts.map((_, i) => `#${i + 1}`).join(' | ') +
      ' | Δ | Δ/cycle | Owner module | Family |',
    '|---|' + rows[0].counts.map(() => '--:').join('|') + '|--:|--:|---|---|',
  ];
  for (const r of rows) {
    const owner = owners.get(r.key);
    const fam = familyOfShape(r.props, families);
    const shape = `{${r.props.join(',')}}`;
    lines.push(
      `| \`${shape.length > 70 ? shape.slice(0, 67) + '…}' : shape}\` | ` +
        r.counts.map(c => (c == null ? '?' : c.toLocaleString())).join(' | ') +
        ` | +${r.delta.toLocaleString()}` +
        ` | ${cycles != null && cycles > 0 ? (r.delta / cycles).toFixed(2) : ''}` +
        ` | ${owner?.module != null ? `${owner.module} (${owner.votes}/${owner.of})` : '?'}` +
        ` | ${fam != null ? `known: \`${fam.id}\`` : '**NEW**'} |`,
    );
  }
  lines.push('');
  return lines;
}
