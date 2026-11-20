/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {cachedPathLabeler} from '../heap-families.js';
import {
  describeElements,
  getSlotBytes,
  readRawElements,
} from '../heap-shapes.js';
import {moduleRecords} from '../module-registry.js';
import {oddballValue} from '../react-shapes.js';
import {entriesRetainedOf, looksLikeRingBuffer} from './cache-analysis.js';
import {
  arrayElements,
  isNoopName,
  moduleRegistryIds,
  sharedCapturedFunction,
} from './framework-buffers.js';
import {
  enumerateMapEntries,
  enumerateSetElements,
  errorResult,
  formatBytes,
  formatNumber,
  heldByLabel,
  markdownTable,
  toolResult,
} from '../utils.js';

const COLLECTIONS = new Set(['Array', 'Map', 'Set', 'WeakMap', 'WeakSet']);
// Elements examined per collection; a larger one is sampled evenly.
const SPLIT_CAP = 20_000;
const DEAD_FLAG = 0.25;

/** What one collection's elements are, by signature. */
export interface ElementSplit {
  /** Elements examined (all of them, or an even sample of SPLIT_CAP). */
  examined: number;
  nullish: number;
  /** False for an Object, whose null fields are ordinary state. */
  nullIsDead: boolean;
  /**
   * Slots with no entry: array holes or small integers (not told apart), and
   * deleted Map/Set entries; `span` is the slot count they are a share of.
   */
  holes: number;
  span: number;
  detached: number;
  tasks: number;
  cancelledTasks: number;
  /** The function most closures capture, when at least half of them do. */
  sameFn: {n: number; name: string; noop: boolean} | null;
  shapes: Array<{shape: string; n: number}>;
  dead: number;
}

/** Each element's signature: an oddball, a closure, a class or `{keys}`. */
function shapeOf(el: IHeapNode | null): {
  shape: string;
  task: boolean;
  cancelled: boolean;
} {
  const plain = {task: false, cancelled: false};
  if (el == null) return {shape: 'smi', ...plain};
  const odd = oddballValue(el);
  if (odd != null) return {shape: odd, ...plain};
  if (el.isString) return {shape: '(string)', ...plain};
  if (el.type === 'closure') {
    return {shape: `${el.name || '(anonymous)'}()`, ...plain};
  }
  if (el.type === 'number' || /number$/.test(el.name)) {
    return {shape: 'number', ...plain};
  }
  if (el.type !== 'object') return {shape: `(${el.name || el.type})`, ...plain};
  const keys: string[] = [];
  let sortIndex = false;
  let expiration = false;
  let callback: IHeapNode | null = null;
  for (const e of el.references) {
    if (e.type !== 'property') continue;
    const k = String(e.name_or_index);
    if (k === '__proto__') continue;
    if (keys.length < 4) keys.push(k);
    if (k === 'sortIndex') sortIndex = true;
    else if (k === 'expirationTime') expiration = true;
    else if (k === 'callback') callback = e.toNode;
  }
  // A React Scheduler task: `unstable_cancelCallback` nulls the callback and
  // leaves the task in its heap until it reaches the top.
  const task = sortIndex && expiration;
  const cancelled = task && (callback == null || callback.type !== 'closure');
  if (el.name !== 'Object') {
    return {shape: el.name.slice(0, 40), task, cancelled};
  }
  const more = keys.length > 3 ? ', …' : '';
  const shape = `{${keys.slice(0, 3).join(', ')}${more}}`;
  return {
    shape: shape.length > 48 ? `${shape.slice(0, 46)}…}` : shape,
    task,
    cancelled,
  };
}

const isDetached = (n: IHeapNode) =>
  n.is_detached || n.name.startsWith('Detached ');

/**
 * The element split of one collection. `elems` holds each element's target,
 * or null for an inline small integer; `holes` of `span` slots hold no entry.
 * `keys`, for a Map, are the keys of the same entries.
 */
export function elementSplit(
  elems: Array<IHeapNode | null>,
  holes = 0,
  span = 0,
  nullIsDead = true,
  keys: Array<IHeapNode | null> | null = null,
): ElementSplit {
  const step = Math.max(1, Math.ceil(elems.length / SPLIT_CAP));
  const s: ElementSplit = {
    examined: 0,
    nullish: 0,
    nullIsDead,
    holes,
    span,
    detached: 0,
    tasks: 0,
    cancelledTasks: 0,
    sameFn: null,
    shapes: [],
    dead: 0,
  };
  const shapes = new Map<string, number>();
  const closures: IHeapNode[] = [];
  for (let i = 0; i < elems.length; i += step) {
    const el = elems[i];
    s.examined++;
    // A Map keyed by a detached element keeps it whatever the value is.
    const key = keys?.[i];
    if (key != null && isDetached(key) && (el == null || !isDetached(el))) {
      s.detached++;
    }
    const {shape, task, cancelled} = shapeOf(el);
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
    if (shape === 'null' || shape === 'undefined') s.nullish++;
    else if (el == null) continue;
    else if (el.type === 'closure') closures.push(el);
    else if (isDetached(el)) s.detached++;
    if (task) s.tasks++;
    if (cancelled) s.cancelledTasks++;
  }
  const shared = closures.length > 0 ? sharedCapturedFunction(closures) : null;
  // A shared capture counts when it marks most closures and a real share of
  // the collection, not two bound methods of nineteen fields.
  if (
    shared != null &&
    shared.best.n >= Math.max(10, shared.closures * 0.5, s.examined * 0.25)
  ) {
    const name = shared.best.name || '(anonymous)';
    s.sameFn = {n: shared.best.n, name, noop: isNoopName(name)};
  }
  s.shapes = [...shapes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([shape, n]) => ({shape, n}));
  // Holes are not counted: a slot with no heap value may be a small integer.
  // A null field of a record is ordinary state; a null slot of a list or map
  // is an entry that was cleared and not removed.
  s.dead =
    (s.nullIsDead ? s.nullish : 0) +
    s.detached +
    s.cancelledTasks +
    (s.sameFn?.noop === true ? s.sameFn.n : 0);
  return s;
}

const pct = (n: number, of: number) =>
  n > 0 && n * 100 < of ? '<1%' : `${of > 0 ? Math.round((n / of) * 100) : 0}%`;

/** The non-zero parts of a split, compact. */
export function formatSplit(s: ElementSplit): string {
  const parts: string[] = [];
  const of = s.examined;
  if (s.nullish > 0) parts.push(`null ${pct(s.nullish, of)}`);
  if (s.holes > 0) parts.push(`holes/smi ${pct(s.holes, s.span)}`);
  if (s.sameFn != null) {
    const what = s.sameFn.noop ? 'no-op wrappers' : 'same captured fn';
    parts.push(`${what} ${pct(s.sameFn.n, of)} \`${s.sameFn.name}\``);
  }
  if (s.detached > 0) parts.push(`detached ${pct(s.detached, of)}`);
  if (s.cancelledTasks > 0) {
    parts.push(`cancelled tasks ${pct(s.cancelledTasks, of)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/** Evidence plus a next step for a row whose dead share crossed the flag. */
function flagNote(
  node: IHeapNode,
  holder: string,
  s: ElementSplit,
  entries: number,
): string {
  const of = formatNumber(s.examined);
  const what: string[] = [];
  if (s.cancelledTasks > 0) {
    what.push(
      `${formatNumber(s.cancelledTasks)} of ${of} are Scheduler tasks with callback null, still queued until they reach the top; check what cancels them`,
    );
  }
  if (s.sameFn?.noop === true) {
    what.push(
      `${formatNumber(s.sameFn.n)} of ${of} are wrappers around \`${s.sameFn.name}\`: cancelled in place, never spliced out; check the remover`,
    );
  }
  if (s.nullish > 0 && s.nullIsDead) {
    // A pre-sized buffer and a list of cleared entries look the same here.
    const ring = node.referrers.some(
      e => e.type === 'property' && looksLikeRingBuffer(e.fromNode),
    );
    what.push(
      `${formatNumber(s.nullish)} of ${of} are null/undefined: ` +
        (ring
          ? 'unused capacity of a pre-sized ring (its owner has a write cursor), so check whether the capacity fits'
          : 'capacity allocated up front, or entries cleared but not removed; compare the capacity with what it holds'),
    );
  }
  if (s.detached > 0) {
    what.push(`${formatNumber(s.detached)} of ${of} are detached DOM nodes`);
  }
  const sample = s.examined < entries ? ' (sampled)' : '';
  const list =
    node.name === 'Array' ? 'memlab_array_group_by' : 'memlab_map_entries';
  return `- @${node.id} \`${holder}\`: ${what.join('; ')}${sample}. ${list} on @${node.id} lists the entries.`;
}

const isHole = (n: IHeapNode | null) =>
  n != null && (n.name === 'the_hole' || n.name === 'system / Hole');

/**
 * Element targets of one collection (null for an inline small integer), and
 * its holes: a deleted Map/Set entry stays in the table as a hole until the
 * next rehash, so it is a slot, not an entry.
 */
function elementsOf(node: IHeapNode): {
  elems: Array<IHeapNode | null>;
  holes: number;
  keys: IHeapNode[] | null;
} {
  let all: Array<IHeapNode | null>;
  if (node.name === 'Array') all = arrayElements(node);
  else if (node.name === 'Map' || node.name === 'WeakMap') {
    const slots = enumerateMapEntries(node);
    const entries = slots.filter(e => !isHole(e.key));
    // A WeakMap holds its keys weakly, so only a Map's keys can be dead.
    const keys = node.name === 'Map' ? entries.map(e => e.key) : null;
    const holes = slots.length - entries.length;
    return {elems: entries.map(e => e.value), holes, keys};
  } else if (node.name === 'Set' || node.name === 'WeakSet') {
    all = enumerateSetElements(node);
  } else {
    all = [];
    for (const e of node.references) {
      if (e.type === 'element') all.push(e.toNode);
      else if (e.type === 'property' && e.name_or_index !== '__proto__') {
        all.push(e.toNode);
      }
    }
  }
  const elems = all.filter(n => !isHole(n));
  return {elems, holes: all.length - elems.length, keys: null};
}

interface Row {
  node: IHeapNode;
  entries: number;
  retained: number;
}

/**
 * Every collection with at least `minEntries` entries, in one pass. Entries
 * live on the collection (arrays with direct element edges, objects) or on
 * its backing store (an `elements` store, a Map/Set `table`); a node with
 * fewer edges than `minEntries` cannot be either, so most nodes cost one
 * comparison.
 */
function findCollections(snapshot: IHeapSnapshot, minEntries: number): Row[] {
  const registries = moduleRegistryIds(snapshot);
  const records = new Set<number>();
  for (const rec of moduleRecords(snapshot).values()) {
    records.add(rec.record.id);
  }
  // A module's `dependencies` array retains the modules it imports: module
  // system bookkeeping, and the largest rows at a low floor if kept.
  const isDependencyList = (n: IHeapNode) =>
    n.referrers.some(
      e => e.name_or_index === 'dependencies' && records.has(e.fromNode.id),
    );
  const seen = new Set<number>();
  const found: IHeapNode[] = [];
  const add = (n: IHeapNode) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    found.push(n);
  };
  snapshot.nodes.forEach((n: IHeapNode) => {
    if (n.edge_count < minEntries) return;
    if (n.type === 'object') {
      // A module registry or record is module-system bookkeeping that
      // retains the whole app.
      if (COLLECTIONS.has(n.name)) add(n);
      else if (
        n.name === 'Object' &&
        !registries.has(n.id) &&
        !records.has(n.id)
      ) {
        add(n);
      }
      return;
    }
    for (const e of n.referrers) {
      const name = String(e.name_or_index);
      if (
        (name === 'elements' || name === 'table' || name === 'backing_store') &&
        COLLECTIONS.has(e.fromNode.name)
      ) {
        add(e.fromNode);
      }
    }
  });
  const rows: Row[] = [];
  for (const node of found) {
    const {elems} = elementsOf(node);
    if (elems.length < minEntries || isDependencyList(node)) continue;
    const retained = Math.max(
      node.retainedSize,
      entriesRetainedOf(node, snapshot)?.retained ?? 0,
    );
    rows.push({node, entries: elems.length, retained});
  }
  return rows;
}

export function registerCollectionCensus(server: McpServer): void {
  server.tool(
    'memlab_collection_census',
    'Every Array, Map, Set, WeakMap, WeakSet and plain Object with at least `min_entries` entries (own properties for an Object), at any owner depth, in one pass. Each row has the holder edge, the path tail, entries, retained bytes and an element split: null/undefined, holes (or small integers), closures wrapping the same captured function (a shared no-op marks wrappers cancelled in place), detached DOM nodes, React Scheduler tasks with callback null, and the top 3 element shapes. Rows whose dead share is at least 25% are flagged with the evidence. ' +
      'An entry floor, not a byte floor: a 100 KB listener array of tombstones shows here even when byte-ranked tools cut it. For small caches ranked by bytes use memlab_cache_analysis.',
    {
      min_entries: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(500)
        .describe('Smallest entry count to list (default 500).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(30)
        .describe('Rows to show (default 30).'),
      sort: z
        .enum(['retained', 'entries'])
        .optional()
        .default('retained')
        .describe('Order rows by retained bytes (default) or by entry count.'),
    },
    async ({min_entries, limit, sort}) => {
      try {
        const snapshot = getSnapshot();
        const rows = findCollections(snapshot, min_entries);
        if (rows.length === 0) {
          return toolResult(
            `No collection has ${formatNumber(min_entries)} or more entries.`,
          );
        }
        rows.sort((a, b) =>
          sort === 'entries'
            ? b.entries - a.entries || b.retained - a.retained
            : b.retained - a.retained || b.entries - a.entries,
        );
        const labeler = cachedPathLabeler(snapshot);
        const slotBytes = getSlotBytes(snapshot);
        const notes: string[] = [];
        let wideObject = false;
        const table = rows.slice(0, limit).map((r, i) => {
          const raw = r.node.name === 'Array' ? readRawElements(r.node) : null;
          const info = raw != null ? describeElements(raw, slotBytes) : null;
          const {elems, holes, keys} = elementsOf(r.node);
          const split =
            info != null
              ? elementSplit(elems, info.holes + holes, info.span)
              : elementSplit(
                  elems,
                  holes,
                  elems.length + holes,
                  r.node.name !== 'Object',
                  keys,
                );
          const holder = heldByLabel(r.node, 40);
          const dead = split.dead / Math.max(1, split.examined);
          if (dead >= DEAD_FLAG) {
            notes.push(flagNote(r.node, holder, split, r.entries));
          }
          if (r.node.name === 'Object' && r.entries > 5000) wideObject = true;
          const path = labeler.labelOf(r.node);
          const deadPct = pct(split.dead, split.examined);
          return [
            String(i + 1),
            `${r.node.name} @${r.node.id}`,
            holder,
            path.length > 40 ? `…${path.slice(-39)}` : path,
            formatNumber(r.entries),
            formatBytes(r.retained),
            formatSplit(split),
            split.shapes
              .map(x => `${x.shape} ${pct(x.n, split.examined)}`)
              .join(', '),
            dead >= DEAD_FLAG ? `**${deadPct}**` : deadPct,
          ];
        });
        const shown = Math.min(limit, rows.length);
        return toolResult(
          [
            `## Collection census — ${formatNumber(rows.length)} collections with ≥ ${formatNumber(min_entries)} entries (top ${shown} by ${sort})`,
            '',
            markdownTable(
              '#|Collection|Held by|Path|Entries|Retained|Split|Top shapes|Dead'.split(
                '|',
              ),
              table,
              new Set([0, 4, 5, 8]),
            ),
            '',
            ...(notes.length > 0
              ? [`**${notes.length} row(s) at least 25% dead:**`, ...notes, '']
              : []),
            '_Dead = null/undefined, detached DOM, Scheduler tasks with callback null and wrappers around a shared no-op. Holes/smi are array slots with no heap value (holes or small integers) and deleted Map/Set entries awaiting a rehash; they are not counted. Retained is the larger of what the collection dominates and what its entries retain; nested collections overlap, so do not sum. Module records, registry tables and `dependencies` lists are left out; null fields of an Object are not counted as dead._',
            ...(wideObject
              ? [
                  '_Objects above 5,000 keys also appear in memlab_framework_buffers, which checks their keys for a per-call counter._',
                ]
              : []),
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
