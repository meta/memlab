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
import fs from 'fs';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {cachedPathLabeler, shapeFamilyOf} from '../heap-families.js';
import {moduleRecords, moduleScopeVars} from '../module-registry.js';
import {entriesRetainedOf} from './cache-analysis.js';
import {countEntries} from './collection-trend.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
  heldByLabel,
} from '../utils.js';

export interface BufferRow {
  buffer: string;
  where: string;
  entries: number | null;
  bytes: number;
  note: string;
  /** The container, when the row is one object. */
  id?: number;
  /** Set when the row is a lead rather than a standing cost. */
  flag?: string;
}

// A `logs` array this long or this heavy is worth a look on its own.
const BIG_LOG_ENTRIES = 10_000;
const BIG_LOG_BYTES = 256 * 1024;

const COLLECTIONS = new Set(['Map', 'Set', 'Array', 'WeakMap']);

function held(node: IHeapNode, snapshot: IHeapSnapshot): number {
  return Math.max(
    node.retainedSize,
    entriesRetainedOf(node, snapshot)?.retained ?? 0,
  );
}

/** The largest collection among a module's exports and top-level variables. */
function largestModuleCollection(
  snapshot: IHeapSnapshot,
  moduleName: string,
): IHeapNode | null {
  const rec = moduleRecords(snapshot).get(moduleName);
  if (rec == null) return null;
  const cands: IHeapNode[] = [];
  for (const v of moduleScopeVars(rec)) {
    if (v.node.type === 'object' && COLLECTIONS.has(v.node.name)) {
      cands.push(v.node);
    }
  }
  for (const root of [rec.exports, rec.defaultExport]) {
    if (root == null) continue;
    for (const e of root.references) {
      if (e.type !== 'property') continue;
      const t = e.toNode;
      if (t.type === 'object' && COLLECTIONS.has(t.name)) cands.push(t);
    }
  }
  let best: IHeapNode | null = null;
  let bestN = -1;
  for (const c of cands) {
    const n = countEntries(c) ?? 0;
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  }
  return best;
}

function propTo(node: IHeapNode, name: string): IHeapNode | null {
  for (const e of node.references) {
    if (e.type === 'property' && String(e.name_or_index) === name) {
      return e.toNode;
    }
  }
  return null;
}

/** Ids of the objects that hold module records by name (module registries). */
export function moduleRegistryIds(snapshot: IHeapSnapshot): Set<number> {
  const ids = new Set<number>();
  for (const rec of moduleRecords(snapshot).values()) {
    for (const e of rec.record.referrers) {
      if (e.type === 'property') ids.add(e.fromNode.id);
    }
  }
  return ids;
}

/** A registry's own table: the object plus its out-of-object property store. */
export function registryTableBytes(registry: IHeapNode): number {
  return (
    registry.self_size +
    (registry.getReferenceNode('properties')?.self_size ?? 0)
  );
}

/**
 * An app-specific buffer, described by where it lives. Which buffers a stack
 * keeps is knowledge about that stack, so it comes from a probe file rather
 * than from this package.
 */
export interface BufferProbe {
  buffer: string;
  note?: string;
  /** The largest collection among this module's exports and scope variables. */
  module?: string;
  /** A dotted path from the global object, e.g. `Telemetry.history`. */
  global?: string;
  /** Every object reached through a property of this name. */
  property?: string;
}

export function loadBufferProbes(configPath?: string): {
  probes: BufferProbe[];
  source: string | null;
} {
  const file = configPath ?? process.env.MEMLAB_FRAMEWORK_BUFFERS;
  if (file == null || file === '') return {probes: [], source: null};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    probes?: unknown;
  };
  if (!Array.isArray(parsed.probes)) {
    throw new Error(`${file}: expected {"probes": [...]}`);
  }
  const probes = (parsed.probes as BufferProbe[]).filter(
    p =>
      typeof p.buffer === 'string' &&
      [p.module, p.global, p.property].filter(x => typeof x === 'string')
        .length === 1,
  );
  return {probes, source: file};
}

/** Entries of a collection, or of the arrays an object holds. */
function entriesOf(node: IHeapNode): number {
  if (['Map', 'Set', 'Array', 'WeakMap'].includes(node.name)) {
    return countEntries(node) ?? 0;
  }
  let entries = 0;
  for (const e of node.references) {
    if (e.type === 'property' && e.toNode.name === 'Array') {
      entries += countEntries(e.toNode) ?? 0;
    }
  }
  return entries;
}

/**
 * Keys of a wide table that end in a per-call counter (`…__4633`, `…_12026`).
 *
 * A table keyed once per module is a fixed cost paid at load. One keyed once per
 * CALL grows for as long as the page runs, and the width alone does not tell
 * the two apart: Comet's `modulesTimeMap` had 27,938 keys, 12,517 of them
 * `__requireModule__<Module>__<n>` with n counting up to 12,026, and was
 * reported as static load cost.
 *
 * Module ids embedded in keys end in digits too (`cr:2046346`), and can share
 * a table with the counted keys, so keys are grouped by the separator before
 * the number and a group counts only when its numbers are DENSE: 12,537 keys
 * numbered up to 12,026 is a counter; 23,249 keys up to 2,046,346 is ids.
 *
 * Density is judged on the longest dense run from the smallest number up, not
 * on the group's maximum: one stray `__mod__2046346` among 12,537 counted keys
 * must not hide the counter. The run is the largest k such that the k
 * smallest numbers all fit in 0..4k, and `count`/`highest` describe that run.
 */
export function perCallKeys(
  table: IHeapNode,
  props: number,
): {count: number; example: string; highest: number} | null {
  const bySep = new Map<string, Array<{n: number; key: string}>>();
  for (const e of table.references) {
    if (e.type !== 'property') continue;
    const key = String(e.name_or_index);
    const m = /(__|[_:#.-])(\d+)$/.exec(key);
    if (m == null) continue;
    const keys = bySep.get(m[1]) ?? [];
    keys.push({n: Number(m[2]), key});
    bySep.set(m[1], keys);
  }
  let best: {count: number; example: string; highest: number} | null = null;
  for (const keys of bySep.values()) {
    keys.sort((a, b) => a.n - b.n);
    let run = 0;
    for (let k = 1; k <= keys.length; k++) {
      if (keys[k - 1].n <= k * 4) run = k;
    }
    // A handful of numbered keys is ordinary naming (`h1`, `step_2`).
    if (run === 0 || (run < 1000 && run < props * 0.2)) continue;
    if (best == null || run > best.count) {
      const last = keys[run - 1];
      best = {count: run, example: last.key, highest: last.n};
    }
  }
  return best;
}

/** The note for a wide table, naming per-call keys when it has them. */
function wideTableNote(table: IHeapNode, props: number, base: string): string {
  const c = perCallKeys(table, props);
  if (c == null) return base;
  return (
    `${c.count.toLocaleString('en-US')} of ${props.toLocaleString('en-US')} keys end in a per-call counter ` +
    `(\`${c.example}\`, up to ${c.highest.toLocaleString('en-US')}): it grows with every call, ` +
    'not once per module, so check what removes those keys'
  );
}

/** Element targets of an array, from the node or its `elements` store. */
export function arrayElements(arr: IHeapNode): IHeapNode[] {
  const out: IHeapNode[] = [];
  let backing: IHeapNode | null = null;
  for (const e of arr.references) {
    if (e.type === 'element') out.push(e.toNode);
    else if (String(e.name_or_index) === 'elements') backing = e.toNode;
  }
  if (backing != null) {
    for (const e of backing.references) {
      if (e.type === 'element') out.push(e.toNode);
    }
  }
  return out;
}

/**
 * Whether a function name is a shared no-op (`emptyFunction`, `noop`).
 *
 * A match turns the tombstone note from "if it is a no-op" into "cancelled in
 * place", so only names that mean nothing else count: not `empty`, not
 * `noopOnServer`, not `logNoop`, which may well do work.
 */
export function isNoopName(name: string): boolean {
  return /^(emptyFunction|_?noop|nop)$/i.test(name);
}

/**
 * A listener array whose entries are wrappers that were cancelled in place.
 *
 * A common remover does not splice its wrapper out of the array: it swaps the
 * wrapped function for a shared no-op (`localFunc = emptyFunction`), so every
 * register/unregister cycle leaves a permanent entry. Comet's
 * `EVENT_LISTENERS.beforeunload` held 4,418 such wrappers of 4,443. Each one
 * is a closure, so the signature is: most of the array's closures capture the
 * SAME function object in their scope.
 */
function tombstonedListeners(
  arr: IHeapNode,
): {entries: number; dead: number; fn: string; bytes: number} | null {
  const elems = arrayElements(arr);
  if (elems.length < 100) return null;
  // Bail out early on arrays that are not arrays of functions.
  if (elems.slice(0, 20).filter(n => n.type === 'closure').length < 10) {
    return null;
  }
  const shared = sharedCapturedFunction(elems);
  if (shared == null) return null;
  const {best, closures} = shared;
  if (best.n < 100 || best.n < closures * 0.5) return null;
  return {
    entries: elems.length,
    dead: best.n,
    fn: best.name === '' ? '(anonymous)' : best.name,
    bytes: best.bytes,
  };
}

/**
 * The function object captured (in their scope) by the most closures among
 * `elems`, with how many closures there are in all. A wrapper cancelled in
 * place captures the shared no-op it was swapped to, so this is the
 * signature of a tombstone.
 */
export function sharedCapturedFunction(elems: IHeapNode[]): {
  best: {n: number; name: string; bytes: number};
  closures: number;
} | null {
  const byFn = new Map<number, {n: number; name: string; bytes: number}>();
  let closures = 0;
  for (const el of elems) {
    if (el.type !== 'closure') continue;
    closures++;
    const ctx = el.getReferenceNode('context');
    if (ctx == null) continue;
    const seen = new Set<number>();
    for (const e of ctx.references) {
      if (e.type !== 'context' || e.toNode.type !== 'closure') continue;
      const fn = e.toNode;
      if (seen.has(fn.id)) continue;
      seen.add(fn.id);
      const g = byFn.get(fn.id) ?? {n: 0, name: fn.name, bytes: 0};
      g.n++;
      g.bytes += el.retainedSize;
      byFn.set(fn.id, g);
    }
  }
  let best: {n: number; name: string; bytes: number} | null = null;
  for (const g of byFn.values()) if (best == null || g.n > best.n) best = g;
  return best == null ? null : {best, closures};
}

/**
 * Buffers that recur across apps: generic ones found by name or shape, plus
 * the app-specific probes. Each probe is minification-safe (module records,
 * globals, shapes) and reports "not present" rather than guessing.
 */
export function probeBuffers(
  snapshot: IHeapSnapshot,
  probes: BufferProbe[],
): BufferRow[] {
  const rows: BufferRow[] = [];
  const labeler = cachedPathLabeler(snapshot);
  const globals: IHeapNode[] = [];
  const logArrays: IHeapNode[] = [];
  const byProperty = new Map<string, BufferProbe>();
  for (const p of probes) if (p.property != null) byProperty.set(p.property, p);
  const propertyHits: Array<{probe: BufferProbe; node: IHeapNode}> = [];
  const giant: IHeapNode[] = [];
  const longArrays: IHeapNode[] = [];
  let timingRecords = 0;
  let timingBytes = 0;
  let resourceRecords = 0;
  let resourceBytes = 0;
  let schedulerTasks = 0;
  let cancelledTasks = 0;
  let cancelledBytes = 0;
  snapshot.nodes.forEach((n: IHeapNode) => {
    if (/^(Window|DedicatedWorkerGlobalScope) /.test(n.name)) globals.push(n);
    if (n.type === 'object' && n.edge_count > 5000) giant.push(n);
    if (n.name === 'Array' && n.edge_count >= 100) longArrays.push(n);
    for (const e of n.references) {
      if (e.type !== 'property') continue;
      const name = String(e.name_or_index);
      const probe = e.toNode.type === 'object' ? byProperty.get(name) : null;
      if (name === 'logs' && e.toNode.name === 'Array') {
        logArrays.push(e.toNode);
      } else if (probe != null) {
        propertyHits.push({probe, node: e.toNode});
      }
    }
    const fam = shapeFamilyOf(n);
    if (fam === 'module timing records') {
      timingRecords++;
      timingBytes += n.retainedSize;
    } else if (fam === 'lazy-loader resource records') {
      resourceRecords++;
      resourceBytes += n.retainedSize;
    }
    if (
      n.type === 'object' &&
      propTo(n, 'sortIndex') != null &&
      propTo(n, 'expirationTime') != null
    ) {
      schedulerTasks++;
      // `unstable_cancelCallback` only nulls the callback; the task stays in
      // its heap until it reaches the top. Any callback that is not a function
      // is a cancelled task.
      const cb = propTo(n, 'callback');
      if (cb != null && cb.type !== 'closure') {
        cancelledTasks++;
        cancelledBytes += n.retainedSize;
      }
    }
  });

  for (const p of probes) {
    if (p.global == null) continue;
    for (const g of globals) {
      let cur: IHeapNode | null = g;
      for (const part of p.global.split('.')) {
        cur = cur != null ? propTo(cur, part) : null;
      }
      if (cur == null) continue;
      rows.push({
        buffer: p.buffer,
        where: p.global,
        entries: entriesOf(cur),
        bytes: held(cur, snapshot),
        note: p.note ?? '',
      });
      break;
    }
  }
  for (const arr of logArrays) {
    const n = countEntries(arr) ?? 0;
    const bytes = held(arr, snapshot);
    // Entry counts can read low when elements live in a backing store, so
    // bytes decide too.
    if (n < 100 && bytes < 64 * 1024) continue;
    rows.push({
      buffer: 'in-memory log buffer',
      where: labeler.labelOf(arr),
      entries: n > 0 ? n : null,
      bytes,
      note: 'a `logs` array; check its cap',
      id: arr.id,
      ...(n >= BIG_LOG_ENTRIES || bytes >= BIG_LOG_BYTES
        ? {flag: 'oversized log'}
        : {}),
    });
  }
  for (const {probe, node} of propertyHits) {
    rows.push({
      buffer: probe.buffer,
      where: labeler.labelOf(node),
      entries: entriesOf(node),
      bytes: held(node, snapshot),
      note: probe.note ?? '',
    });
  }
  for (const p of probes) {
    if (p.module == null) continue;
    const c = largestModuleCollection(snapshot, p.module);
    if (c == null) continue;
    rows.push({
      buffer: p.buffer,
      where: `${p.module} (${c.name})`,
      entries: countEntries(c),
      bytes: held(c, snapshot),
      note: p.note ?? '',
    });
  }
  if (resourceRecords > 0) {
    rows.push({
      buffer: 'lazy-loader resource registry',
      where: '{c, m, p, src, type} records',
      entries: resourceRecords,
      bytes: resourceBytes,
      note: 'static-resource metadata for every known resource',
    });
  }
  if (timingRecords > 0) {
    rows.push({
      buffer: 'module timing records',
      where: '{category, defined, factoryRun, …} records',
      entries: timingRecords,
      bytes: timingBytes,
      note: 'one per loaded module',
    });
  }
  if (schedulerTasks > 0) {
    // A queue of mostly cancelled tasks is the finding, not its pending
    // timers: Comet's timerQueue held 12,605 cancelled tasks of 13,207.
    const mostlyCancelled =
      cancelledTasks >= 100 && cancelledTasks >= schedulerTasks * 0.5;
    rows.push({
      buffer: 'scheduler task queue',
      where: 'React Scheduler task records',
      entries: schedulerTasks,
      bytes: mostlyCancelled ? cancelledBytes : 0,
      note: mostlyCancelled
        ? `${cancelledTasks.toLocaleString('en-US')} of ${schedulerTasks.toLocaleString('en-US')} are cancelled (callback null) and stay queued until they reach the top; Held counts those`
        : 'pending timers; see memlab_timers for what they capture',
      ...(mostlyCancelled ? {flag: 'cancelled scheduler tasks'} : {}),
    });
  }
  for (const arr of longArrays) {
    const t = tombstonedListeners(arr);
    if (t == null) continue;
    const noop = isNoopName(t.fn);
    rows.push({
      buffer: 'listener array of cancelled wrappers',
      // The module path finds the scope; the array's own edge
      // (`Object.beforeunload`) says which event it is.
      where: `${labeler.labelOf(arr)} (${heldByLabel(arr, 40)})`,
      entries: t.entries,
      bytes: t.bytes,
      id: arr.id,
      flag: 'cancelled-in-place listeners',
      note: noop
        ? `${t.dead.toLocaleString('en-US')} of ${t.entries.toLocaleString('en-US')} entries are wrappers around \`${t.fn}\`: cancelled in place and never spliced out, so the array grows with every register/unregister`
        : `${t.dead.toLocaleString('en-US')} of ${t.entries.toLocaleString('en-US')} entries wrap the same function \`${t.fn}\`; if it is a no-op, these are cancelled entries left in place`,
    });
  }
  const registryIds = moduleRegistryIds(snapshot);
  giant
    .map(g => {
      let props = 0;
      for (const e of g.references) if (e.type === 'property') props++;
      return {g, props};
    })
    .filter(x => x.props > 5000)
    .sort((a, b) => b.props - a.props)
    .slice(0, 6)
    .forEach(({g, props}) => {
      // A module registry is wide by design and reaches the whole app; count
      // only its own table, not everything behind it.
      const isRegistry = registryIds.has(g.id);
      const perCall = perCallKeys(g, props) != null;
      rows.push({
        id: g.id,
        ...(perCall ? {flag: 'per-call keys'} : {}),
        buffer: isRegistry
          ? 'module registry table'
          : 'giant object (>5,000 own properties)',
        where: labeler.labelOf(g),
        entries: props,
        bytes: isRegistry ? registryTableBytes(g) : g.retainedSize,
        note: wideTableNote(
          g,
          props,
          isRegistry
            ? 'one entry per module; module state is attributed by memlab_module_attribution'
            : 'a prototype or table this wide is static cost paid at load',
        ),
      });
    });
  return rows;
}

export function registerFrameworkBuffers(server: McpServer): void {
  server.tool(
    'memlab_framework_buffers',
    'Size the framework buffers that recur in every hunt on the same stack, in ONE call, minification-safe. Generic probes: in-memory `logs` arrays, module timing records, a lazy-loader resource registry, the React Scheduler task queue (with its cancelled tasks), listener arrays whose entries were cancelled in place (wrappers around one shared no-op), module registry tables and objects with more than 5,000 own properties (with keys that carry a per-call counter). ' +
      'App-specific buffers (a telemetry queue, an error history, a trace store) come from a probe file: JSON `{"probes": [{"buffer", "note", and one of "module" | "global" | "property"}]}`, read from `config_path` or the MEMLAB_FRAMEWORK_BUFFERS environment variable. ' +
      'Each row has its entry count, held bytes (the larger of what the container dominates and what its entries retain) and what it is for. A buffer that is absent is omitted rather than reported as zero.',
    {
      config_path: z
        .string()
        .optional()
        .describe(
          'Probe file to use instead of MEMLAB_FRAMEWORK_BUFFERS (JSON, see the description).',
        ),
    },
    async ({config_path}) => {
      try {
        const snapshot = getSnapshot();
        // A bad probe file costs the app-specific rows, not the generic ones.
        let probes: BufferProbe[] = [];
        let source: string | null = null;
        let probeError: string | null = null;
        try {
          ({probes, source} = loadBufferProbes(config_path));
        } catch (err) {
          probeError = err instanceof Error ? err.message : String(err);
        }
        const rows = probeBuffers(snapshot, probes).sort(
          (a, b) => b.bytes - a.bytes,
        );
        const probeNote =
          probeError != null
            ? `⚠ Probe file not used (${probeError}); generic probes only.`
            : source != null
              ? `_${probes.length} app-specific probe(s) from \`${source}\`._`
              : '_Generic probes only: no probe file (`config_path` or MEMLAB_FRAMEWORK_BUFFERS) was given._';
        if (rows.length === 0) {
          return toolResult(
            `None of the known framework buffers are present.\n\n${probeNote}`,
          );
        }
        return toolResult(
          [
            `## Framework buffers — ${rows.length} found`,
            '',
            markdownTable(
              ['Buffer', 'Where', 'Entries', 'Held', 'What it is'],
              rows.map(r => [
                r.buffer,
                r.where.length > 60 ? `${r.where.slice(0, 57)}…` : r.where,
                r.entries != null ? formatNumber(r.entries) : '—',
                r.bytes > 0 ? formatBytes(r.bytes) : '—',
                r.note,
              ]),
              new Set([2, 3]),
            ),
            '',
            '_Held bytes overlap between buffers that share entries (one record held by two buffers counts in both); do not sum the column._',
            probeNote,
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
