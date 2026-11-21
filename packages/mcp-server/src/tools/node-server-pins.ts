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
import {nativeContextAttribution} from '../native-context.js';
import {
  clampLabelTo,
  flattenString,
  formatBytes,
  formatNumber,
  heldByLabel,
  markdownTable,
} from '../utils.js';
import {findRootIds} from './what-if.js';

/**
 * Two Node.js server findings `memlab_node_server` names directly, because
 * agents read the generic numbers the wrong way:
 *
 * 1. Who holds each extra `vm` realm. On a Next.js server, 5 of 7 realms
 *    (~139 KB each) were each held by one key of a route manifest cache
 *    (`clientReferenceManifestsPerRoute`, load-manifest `sharedCache`): one
 *    realm per route served. Every agent saw only the NativeContext's weak
 *    `(Global handles)` referrers and called them startup contexts.
 * 2. Chunks loaded but never evaluated. A Turbopack chunk is an array of
 *    module factories; a factory that ran leaves closures whose context is a
 *    function Context. An SSR copy of a 1.8 MB DB chunk had 254 closures, all
 *    top-level factories (257 registered in the runtime's factory Map) and
 *    none from a module body, so nothing in it ever ran.
 */

const NATIVE_CONTEXT_RE = /^(Detached )?system \/ NativeContext( \/ |$)/;
const CONTEXTIFY_RE = /(^|\/ )ContextifyContext$/;
/** Holders that only carry a parent object's slots: report the parent. */
const EPHEMERON_RE = / part of key /;
const SLOT_ARRAY_RE =
  /^(system \/ PropertyArray|\(object (properties|elements)\))$/;

function ref(node: IHeapNode, name: string): IHeapNode | null {
  for (const e of node.references) {
    if (String(e.name_or_index) === name) return e.toNode;
  }
  return null;
}

/**
 * Strong reachability from the GC roots, per node ordinal. Weak edges are not
 * followed, nor are Node's `BaseObjectList` edges: that list tracks every
 * native wrapper, including ones Node holds weakly (a ContextifyContext), so
 * following it would keep every realm alive. `cut` drops nodes from the walk.
 */
export function strongReach(
  snapshot: IHeapSnapshot,
  cut: Uint8Array | null = null,
): Uint8Array {
  const seen = new Uint8Array(snapshot.nodes.length);
  const stack: number[] = [];
  for (const id of findRootIds(snapshot)) {
    const root = snapshot.getNodeById(id);
    if (root != null) {
      seen[root.nodeIndex] = 1;
      stack.push(root.nodeIndex);
    }
  }
  while (stack.length > 0) {
    const node = snapshot.nodes.get(stack.pop() as number);
    if (node == null || node.name === 'Node / BaseObjectList') continue;
    node.forEachReference((e: IHeapEdge) => {
      if (e.type === 'weak') return;
      const to = e.toNode.nodeIndex;
      if (seen[to] === 1 || (cut != null && cut[to] === 1)) return;
      seen[to] = 1;
      stack.push(to);
    });
  }
  return seen;
}

/** Self bytes strongly reachable in `before` but not after the cut. */
function freedBy(
  snapshot: IHeapSnapshot,
  before: Uint8Array,
  cut: Uint8Array,
): number {
  const after = strongReach(snapshot, cut);
  let bytes = 0;
  snapshot.nodes.forEach((n: IHeapNode) => {
    if (before[n.nodeIndex] === 1 && after[n.nodeIndex] !== 1) {
      bytes += n.self_size;
    }
  });
  return bytes;
}

/** The Map whose backing table `node` is, if it is one. */
function mapOfTable(node: IHeapNode): IHeapNode | null {
  for (const e of node.referrers) {
    if (String(e.name_or_index) === 'table' && e.fromNode.name === 'Map') {
      return e.fromNode;
    }
  }
  return null;
}

export interface MapSlot {
  map: IHeapNode;
  key: string;
  value: IHeapNode;
}

/** The Map entry holding `value` in backing table `table`, with its key. */
export function mapSlotOf(table: IHeapNode, value: IHeapNode): MapSlot | null {
  const map = mapOfTable(table);
  if (map == null) return null;
  let idx = -1;
  const keys = new Map<number, IHeapNode>();
  for (const e of table.references) {
    const i = Number(e.name_or_index);
    if (!Number.isFinite(i)) continue;
    if (e.toNode === value || e.toNode.id === value.id) idx = i;
    keys.set(i, e.toNode);
  }
  if (idx < 0) return null;
  const k = keys.get(idx - 1);
  const key =
    k == null
      ? '?'
      : k.isString
        ? flattenString(k, 300).value
        : `${k.name || k.type} @${k.id}`;
  return {map, key, value};
}

export interface RealmPin {
  context: IHeapNode;
  /** Reachable from the roots without weak edges and Node's BaseObjectList. */
  strong: boolean;
  slots: MapSlot[];
  /** Holders outside any Map, as `holder.edge` labels. */
  others: string[];
}

export interface RealmGroup {
  map: IHeapNode;
  /** Other Maps holding the same realms, one key each. */
  also: IHeapNode[];
  realms: RealmPin[];
  keys: string[];
}

export interface RealmPins {
  pins: RealmPin[];
  groups: RealmGroup[];
}

const pinsCache = new WeakMap<IHeapSnapshot, RealmPins>();

/**
 * Per non-main realm of a Node.js heap that has `vm` contexts: the strong
 * edges into it from outside, named as Map entries where they are one.
 */
export function realmPins(snapshot: IHeapSnapshot): RealmPins {
  const hit = pinsCache.get(snapshot);
  if (hit != null) return hit;
  const empty: RealmPins = {pins: [], groups: []};
  let contexts = 0;
  let contextify = false;
  snapshot.nodes.forEach((n: IHeapNode) => {
    if (NATIVE_CONTEXT_RE.test(n.name)) contexts++;
    else if (n.type === 'native' && CONTEXTIFY_RE.test(n.name)) {
      contextify = true;
    }
  });
  if (contexts < 2 || !contextify) {
    pinsCache.set(snapshot, empty);
    return empty;
  }
  const a = nativeContextAttribution(snapshot);
  const main = a.contexts[0].ordinal;
  const byOrdinal = new Map<number, RealmPin>();
  for (const c of a.contexts.slice(1)) {
    const context = snapshot.nodes.get(c.ordinal) as IHeapNode;
    byOrdinal.set(c.ordinal, {context, strong: false, slots: [], others: []});
  }
  const reach = strongReach(snapshot);
  // Doors: strong edges from a reachable object owned elsewhere into a realm.
  const doors = new Map<RealmPin, Array<{from: IHeapNode; e: IHeapEdge}>>();
  snapshot.nodes.forEach((from: IHeapNode) => {
    if (reach[from.nodeIndex] !== 1 || from.type === 'synthetic') return;
    if (from.name === 'Node / BaseObjectList') return;
    const own = a.owner[from.nodeIndex];
    from.forEachReference((e: IHeapEdge) => {
      if (e.type === 'weak' || e.type === 'shortcut') return;
      // An ephemeron slot holds its value only while the key lives.
      if (EPHEMERON_RE.test(String(e.name_or_index))) return;
      const to = a.owner[e.toNode.nodeIndex];
      if (to === own || to === main || to < 0) return;
      const pin = byOrdinal.get(to);
      if (pin == null) return;
      let list = doors.get(pin);
      if (list == null) doors.set(pin, (list = []));
      list.push({from, e});
    });
  });
  for (const pin of byOrdinal.values()) {
    pin.strong = reach[pin.context.nodeIndex] === 1;
    const seenMaps = new Set<string>();
    for (const {from, e} of doors.get(pin) ?? []) {
      let holder = from;
      if (SLOT_ARRAY_RE.test(from.name) || from.name === '') {
        const parent = from.referrers.find(r =>
          ['properties', 'elements'].includes(String(r.name_or_index)),
        );
        if (parent != null) holder = parent.fromNode;
      }
      // The holder is a Map's table, or is itself a value in one.
      let slot = mapSlotOf(holder, e.toNode);
      for (const r of slot == null ? holder.referrers : []) {
        if (r.type === 'weak' || r.type === 'shortcut') continue;
        slot = mapSlotOf(r.fromNode, holder);
        if (slot != null) break;
      }
      if (slot != null) {
        const k = `${slot.map.id}\0${slot.key}`;
        if (!seenMaps.has(k)) pin.slots.push(slot);
        seenMaps.add(k);
        continue;
      }
      const edge = clampLabelTo(String(e.name_or_index), 30);
      const label =
        e.type === 'context'
          ? `closure var ${edge} (Context @${holder.id})`
          : `${holder.name || holder.type} @${holder.id}.${edge} ` +
            `(${heldByLabel(holder, 30)})`;
      if (!pin.others.includes(label)) pin.others.push(label);
    }
  }
  const pins = [...byOrdinal.values()].sort(
    (x, y) => y.context.retainedSize - x.context.retainedSize,
  );
  // A Map holding 2+ realms, each under its own key: one realm per key.
  const perMap = new Map<number, RealmGroup>();
  for (const pin of pins) {
    for (const s of pin.slots) {
      let g = perMap.get(s.map.id);
      if (g == null) {
        g = {map: s.map, also: [], realms: [], keys: []};
        perMap.set(s.map.id, g);
      }
      if (!g.realms.includes(pin)) g.realms.push(pin);
      if (!g.keys.includes(s.key)) g.keys.push(s.key);
    }
  }
  // Shortest keys first: route names read better than file paths.
  const keyLen = (g: RealmGroup) =>
    g.keys.reduce((n, k) => n + k.length, 0) / g.keys.length;
  const groups = [...perMap.values()]
    .filter(g => g.realms.length >= 2 && g.keys.length >= g.realms.length)
    .sort(
      (x, y) =>
        y.realms.length - x.realms.length ||
        keyLen(x) - keyLen(y) ||
        x.map.id - y.map.id,
    );
  // Maps holding the same realm set are one group, named by the first Map.
  const kept: RealmGroup[] = [];
  for (const g of groups) {
    const same = kept.find(
      k =>
        k.realms.length === g.realms.length &&
        g.realms.every(r => k.realms.includes(r)),
    );
    if (same == null) kept.push(g);
    else same.also.push(g.map);
  }
  const result = {pins, groups: kept};
  pinsCache.set(snapshot, result);
  return result;
}

/** The tail of a long key: '…/health/route_client-reference-manifest.js'. */
function keyLabel(key: string, max = 48): string {
  return key.length > max ? `…${key.slice(key.length - max + 1)}` : key;
}

function mapLabel(map: IHeapNode): string {
  return `Map @${map.id} (${heldByLabel(map, 44)})`;
}

const groupBytes = (g: RealmGroup) =>
  g.realms.reduce((s, p) => s + p.context.retainedSize, 0);

function groupLine(g: RealmGroup): string {
  const maps = [g.map, ...g.also].map(mapLabel).join(' and ');
  const keys = g.keys
    .slice(0, 3)
    .map(k => `'${keyLabel(k, 36)}'`)
    .join(', ');
  const more =
    g.keys.length > 3 ? `, … ${formatNumber(g.keys.length)} keys` : '';
  const strong = g.realms.filter(r => r.strong).length;
  const held =
    strong === g.realms.length
      ? 'strongly held'
      : `${formatNumber(strong)} strongly held`;
  return `**${formatNumber(g.realms.length)} realms, one per key of ${maps}: ${formatBytes(groupBytes(g))}, ${held}, +1 realm per new key** (${keys}${more}). A fixed startup count would not track a cache's keys; compare a later snapshot to confirm growth.`;
}

/** The `memlab_node_server` section: one row per non-main realm. */
export function realmPinLines(
  snapshot: IHeapSnapshot,
  limit: number,
): string[] {
  const {pins, groups} = realmPins(snapshot);
  if (pins.length === 0) return [];
  const lines = ['## Who holds each extra realm', ''];
  for (const g of groups) lines.push(groupLine(g), '');
  const grouped = new Set(
    groups.flatMap(g => [g.map, ...g.also]).map(m => m.id),
  );
  const rows = pins.slice(0, limit).map(p => {
    const held = [
      ...p.slots.map(s => {
        const map = grouped.has(s.map.id)
          ? `Map @${s.map.id}`
          : mapLabel(s.map);
        return `${map}['${keyLabel(s.key, 40)}'] → @${s.value.id}`;
      }),
      ...p.others,
    ];
    return [
      `@${p.context.id}`,
      formatBytes(p.context.retainedSize),
      p.strong ? 'yes' : 'no: weak handles / BaseObjectList only',
      (held.slice(0, 2).join('; ') || '-') +
        (held.length > 2 ? ` (+${held.length - 2})` : ''),
    ];
  });
  lines.push(
    markdownTable(
      ['NativeContext', 'Retained', 'Strongly held', 'Held by'],
      rows,
      new Set([1]),
    ),
    '',
    "_Strongly held = reachable from the GC roots without weak edges (a NativeContext's `(Global handles)` referrers are weak) and without Node's BaseObjectList. Any object created inside a realm keeps it alive: here the cached objects in Held by._",
    '',
  );
  return lines;
}

export interface UnevaluatedScript {
  script: IHeapNode;
  sourceBytes: number;
  /** Its closures; `factories` of them sit in an array or a Map entry. */
  members: IHeapNode[];
  factories: number;
  /** Closures with a function Context: code from the script that ran. */
  inner: number;
  /** Map table slots pointing at its factories, per Map. */
  registered: Map<IHeapNode, number>;
  /** The array holding its factories (a Turbopack chunk's exports). */
  array: IHeapNode | null;
  freed: number;
}

const MIN_FACTORIES = 10;

/**
 * Scripts whose closures are all top-level (context = the NativeContext), at
 * least 95% of them module factories (held by an array element or a Map
 * entry), and none from a function that ran (context = a function Context):
 * loaded, never evaluated. `freedLimit` caps the reachability walks for the
 * freed bytes; 0 skips them (and the full-heap walk) and leaves `freed` at 0.
 */
export function unevaluatedScripts(
  snapshot: IHeapSnapshot,
  freedLimit = 10,
): UnevaluatedScript[] {
  const rows = new Map<number, UnevaluatedScript>();
  const tables = new Map<number, IHeapNode | null>();
  snapshot.nodes.forEach((n: IHeapNode) => {
    if (n.type !== 'closure') return;
    const sfi = ref(n, 'shared');
    const script =
      sfi && (ref(sfi, 'script') ?? ref(sfi, 'script_or_debug_info'));
    if (script == null || script.type !== 'code') return;
    let row = rows.get(script.nodeIndex);
    if (row == null) {
      const src = ref(script, 'source');
      row = {
        script,
        sourceBytes: src == null ? 0 : src.retainedSize || src.self_size,
        members: [],
        factories: 0,
        inner: 0,
        registered: new Map(),
        array: null,
        freed: 0,
      };
      rows.set(script.nodeIndex, row);
    }
    row.members.push(n);
    const ctx = ref(n, 'context');
    if (ctx == null || !NATIVE_CONTEXT_RE.test(ctx.name)) {
      row.inner++;
      return;
    }
    let factory = false;
    for (const e of n.referrers) {
      const from = e.fromNode;
      let map = tables.get(from.nodeIndex);
      if (map === undefined) {
        map = from.type === 'array' ? mapOfTable(from) : null;
        tables.set(from.nodeIndex, map);
      }
      if (map != null) {
        row.registered.set(map, (row.registered.get(map) ?? 0) + 1);
      } else if (e.type === 'element') {
        row.array ??= from;
      } else if (from.name !== '(object elements)') {
        continue;
      }
      factory = true;
    }
    if (factory) row.factories++;
  });
  const hits = [...rows.values()]
    .filter(
      r =>
        r.inner === 0 &&
        r.factories >= MIN_FACTORIES &&
        r.factories >= 0.95 * r.members.length,
    )
    .sort((x, y) => y.sourceBytes - x.sourceBytes);
  // The sweep passes 0: skip the full-heap reachability walk it would not use.
  if (hits.length === 0 || freedLimit <= 0) return hits;
  const reach = strongReach(snapshot);
  for (const r of hits.slice(0, freedLimit)) {
    const cut = new Uint8Array(snapshot.nodes.length);
    cut[r.script.nodeIndex] = 1;
    for (const m of r.members) cut[m.nodeIndex] = 1;
    r.freed = freedBy(snapshot, reach, cut);
  }
  return hits;
}

function scriptLabel(s: IHeapNode, max: number): string {
  const parts = s.name.split(/[\\/]/);
  const tail = parts.slice(-2).join('/');
  const label = parts.length > 2 ? `…/${tail}` : s.name || '(no name)';
  return clampLabelTo(label, max);
}

function registeredLabel(u: UnevaluatedScript): string {
  if (u.registered.size === 0) return '0 (never registered)';
  return [...u.registered]
    .map(
      ([m, n]) => `${formatNumber(n)} in Map @${m.id} (${heldByLabel(m, 40)})`,
    )
    .join('; ');
}

/** The `memlab_node_server` section for chunks loaded but never evaluated. */
export function unevaluatedLines(
  snapshot: IHeapSnapshot,
  limit: number,
): string[] {
  const hits = unevaluatedScripts(snapshot, limit);
  if (hits.length === 0) return [];
  const source = hits.reduce((s, h) => s + h.sourceBytes, 0);
  return [
    `## Loaded but never evaluated: ${formatNumber(hits.length)} script(s), ${formatBytes(source)} of source`,
    '',
    markdownTable(
      [
        'Script',
        'Source',
        'Closures',
        'Factories registered',
        'Factory array held by',
        'Freed if removed',
      ],
      hits
        .slice(0, limit)
        .map(h => [
          `${scriptLabel(h.script, 60)} @${h.script.id}`,
          formatBytes(h.sourceBytes),
          h.factories === h.members.length
            ? `${formatNumber(h.members.length)} (all factories, 0 inner)`
            : `${formatNumber(h.members.length)} (${formatNumber(h.factories)} factories, 0 inner)`,
          registeredLabel(h),
          h.array == null ? '-' : `@${h.array.id} ${heldByLabel(h.array, 36)}`,
          formatBytes(h.freed),
        ]),
      new Set([1, 2, 5]),
    ),
    '',
    '_Every closure from these scripts was created at top level (its Context is the NativeContext), and at least 95% are module factories held by an array or a module-factory Map. None has a function Context, so no factory ran (a module body that ran leaves closures over its scope). Registered = slots in a module-factory Map; 0 = no factory Map holds them (with Turbopack: another chunk registered those module ids first). Freed = self bytes no longer strongly reachable without the script and its factories. Check what imports the chunk before removing it._',
    '',
  ];
}

/** Compact lines for `memlab_sweep` on a Node.js heap; none on any other. */
export function nodeServerPinsSweepSection(
  snapshot: IHeapSnapshot,
  env: string,
): string[] {
  if (env !== 'node') return [];
  const out: string[] = [];
  for (const g of realmPins(snapshot).groups) {
    out.push(
      `- ${formatNumber(g.realms.length)} vm realms, one per key of ${mapLabel(g.map)} ('${keyLabel(g.keys[0], 36)}', …), ${formatBytes(groupBytes(g))}, strongly held; +1 realm per new key → \`memlab_node_server\``,
    );
  }
  const hits = unevaluatedScripts(snapshot, 0);
  if (hits.length > 0) {
    const named = hits
      .slice(0, 3)
      .map(
        h => `\`${scriptLabel(h.script, 50)}\` ${formatBytes(h.sourceBytes)}`,
      )
      .join(', ');
    out.push(
      `- ${formatNumber(hits.length)} script(s) loaded but never evaluated (module factories only, none ran): ${named} → \`memlab_node_server\``,
    );
  }
  return out;
}
