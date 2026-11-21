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
import {resolveRungs, withSnapshotAt} from '../snapshot-borrow.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  heldByLabel,
  markdownTable,
  pathsHeader,
  sanitizeForTable,
  toolResult,
} from '../utils.js';
import {countEntries} from './collection-trend.js';
import {loadSnapshotByPath} from './explain-delta.js';
import {arrayElements} from './framework-buffers.js';

/**
 * `memlab_diagnostic_buffers`: the app's own instrumentation, inventoried.
 *
 * Agents waved these off as "bounded, not a memory problem": an error history
 * of 51 entries, 35 of them one repeated fbt error with its own message,
 * stack and parsed frames each time; a Performance timeline of 1,091 resource
 * entries that nobody clears; a telemetry queue that grows rung over rung.
 * Bounded is a property of the count, not of the bytes.
 */

export interface DiagRow {
  kind: 'error history' | 'perf timeline' | 'telemetry queue';
  holder: string;
  id: number;
  entries: number;
  bytes: number;
  detail: string;
  /** The same buffer at every rung. */
  key: string;
  /** A timeline's entry counts by type, for the per-rung series. */
  types?: Record<string, number>;
}

export interface DiagExcluded {
  id: number;
  what: string;
  bytes: number;
  realm: string;
}

const ERROR_NAME_RE = /^[A-Z][A-Za-z]*Error$/;
const PERF_ENTRY_RE =
  /^(Performance\w*Timing|PerformanceMark|PerformanceMeasure|LayoutShift|LargestContentfulPaint|VisibilityStateEntry|TaskAttributionTiming)$/;
const TELEMETRY_RE =
  /banzai|logger|telemetry|metrics|trace|batch|queue|expired/i;
// For function names: `queue` alone is ordinary scheduling (`queueWork`).
const SCOPE_RE = /banzai|logger|telemetry|metrics|trace|batch|expired/i;
// A path segment or function named `log`, `logs` or `__log`.
const LOG_SEGMENT_RE = /(?:^|[.:\s(])_*logs?(?=$|[.\s)])/i;
const COLLECTIONS = new Set(['Array', 'Map', 'Set']);
// Chrome's (and Node's) default resource-timing buffer.
const RESOURCE_BUFFER = 250;
const MIN_ERRORS = 10;
const MIN_PERF_COPIES = 100;
const MIN_BYTES = 16 * 1024;
// V8 records at most this many characters of a string's content.
const NAME_CAP = 1024;

export function isTelemetryName(text: string): boolean {
  return TELEMETRY_RE.test(text) || LOG_SEGMENT_RE.test(text);
}

const hasProp = (node: IHeapNode, name: string) =>
  node.getReferenceNode(name, 'property') != null;

export function isErrorLike(node: IHeapNode): boolean {
  if (node.type !== 'object') return false;
  if (ERROR_NAME_RE.test(node.name)) return true;
  return hasProp(node, 'message') && hasProp(node, 'stack');
}

/** A PerformanceEntry wrapper, or a JS record copied from one. */
export function isPerfRecord(node: IHeapNode): boolean {
  if (node.type !== 'object') return false;
  if (PERF_ENTRY_RE.test(node.name)) return true;
  return (
    hasProp(node, 'startTime') &&
    (hasProp(node, 'entryType') || hasProp(node, 'processingStart'))
  );
}

/** The first `k` element targets of an array, without listing them all. */
function sampleElements(arr: IHeapNode, k: number): IHeapNode[] {
  const out: IHeapNode[] = [];
  const backing = arr.getReferenceNode('elements');
  for (const owner of backing != null ? [arr, backing] : [arr]) {
    for (const e of owner.references) {
      if (e.type === 'element' && out.push(e.toNode) >= k) return out;
    }
  }
  return out;
}

/**
 * A string's content as an identity key. V8 keeps only the first 1,024
 * characters of a string, so two stacks that differ past that point read the
 * same; a capped piece adds its byte size to the key, which keeps them apart
 * (an exact copy has the same size).
 */
export function stringKey(node: IHeapNode | null): string {
  if (node == null) return '';
  if (!node.isString) return `@${node.type}`;
  const parts: string[] = [];
  const stack: IHeapNode[] = [node];
  for (let guard = 0; stack.length > 0 && guard < 64; guard++) {
    const s = stack.pop() as IHeapNode;
    if (s.type === 'concatenated string') {
      for (const k of ['second', 'first']) {
        const part = s.getReferenceNode(k);
        if (part != null) stack.push(part);
      }
    } else if (s.type === 'sliced string') {
      const parent = s.getReferenceNode('parent')?.id;
      parts.push(`<slice ${s.self_size} of @${parent}>`);
    } else {
      const capped = s.name.length >= NAME_CAP;
      parts.push(capped ? `${s.name}#${s.self_size}` : s.name);
    }
  }
  return parts.join('');
}

function shorten(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** An error history's entries, grouped by exact message + stack. */
export function errorGroups(errors: IHeapNode[]): {
  distinct: number;
  topMessage: string;
  topCount: number;
  topVariants: number;
  dupRecords: number;
  dupText: number;
} {
  const exact = new Set<string>();
  const byMessage = new Map<string, {n: number; keys: Set<string>}>();
  let dupRecords = 0;
  let dupText = 0;
  for (const err of errors) {
    const msg = err.getReferenceNode('message', 'property');
    const stack = err.getReferenceNode('stack', 'property');
    const key = `${stringKey(msg)}\u0000${stringKey(stack)}`;
    // Every entry after the first of its group is what a dedupe frees.
    if (exact.has(key)) {
      dupRecords += err.retainedSize;
      dupText += (msg?.retainedSize ?? 0) + (stack?.retainedSize ?? 0);
    }
    exact.add(key);
    const short = shorten(msg?.isString ? msg.name : '(no message)', 60);
    const m = byMessage.get(short) ?? {n: 0, keys: new Set<string>()};
    m.n++;
    m.keys.add(key);
    byMessage.set(short, m);
  }
  let top: [string, {n: number; keys: Set<string>}] = [
    '',
    {n: 0, keys: new Set()},
  ];
  for (const entry of byMessage) if (entry[1].n > top[1].n) top = entry;
  return {
    distinct: exact.size,
    topMessage: top[0],
    topCount: top[1].n,
    topVariants: top[1].keys.size,
    dupRecords,
    dupText,
  };
}

/** A JS object's realm: object → map → meta-map → NativeContext. */
export function realmOf(node: IHeapNode): IHeapNode | null {
  const map = node.getReferenceNode('map', 'internal');
  const meta = map?.getReferenceNode('map', 'internal');
  return meta?.getReferenceNode('native_context', 'internal') ?? null;
}

/** Entry types a native Performance object buffers, by its internal lists. */
function timeline(perf: IHeapNode): {entries: number; row: Partial<DiagRow>} {
  const types: Array<{type: string; n: number; bytes: number}> = [];
  for (const e of perf.references) {
    const list = e.toNode;
    if (list.name !== 'InternalNode') continue;
    let n = 0;
    let type = '';
    for (const f of list.references) {
      if (PERF_ENTRY_RE.test(f.toNode.name)) [n, type] = [n + 1, f.toNode.name];
    }
    if (n > 0) types.push({type, n, bytes: list.retainedSize});
  }
  types.sort((a, b) => b.bytes - a.bytes);
  const parts = types
    .slice(0, 4)
    .map(
      t => `${short(t.type)} ${formatNumber(t.n)} (${formatBytes(t.bytes)})`,
    );
  const res = types.find(t => t.type === 'PerformanceResourceTiming');
  if (res != null && res.n > RESOURCE_BUFFER) {
    parts.push(
      `${formatNumber(res.n)} resource entries is above the default ${RESOURCE_BUFFER}-entry buffer: the page raised it (setResourceTimingBufferSize) and has not cleared it (clearResourceTimings)`,
    );
  }
  return {
    entries: types.reduce((s, t) => s + t.n, 0),
    row: {
      detail: parts.join('; '),
      types: Object.fromEntries(types.map(t => [t.type, t.n])),
    },
  };
}

const short = (type: string) => type.replace(/^Performance/, '');

/**
 * Telemetry names of the functions that share the scope holding `node`.
 *
 * A minified bundle keeps method names but not module or variable names:
 * BanzaiComet's post buffer reads as `module:cr:7383.post` held by
 * `closure var m`, and only the functions closing over that scope
 * (`_expiredBatchMap`, `_flushBatchMap`) say what it is.
 */
export function scopeNames(node: IHeapNode): string[] {
  let cur = node.dominatorNode;
  for (let hops = 0; cur != null && hops < 3; hops++, cur = cur.dominatorNode) {
    if (cur.name !== 'system / Context') continue;
    const names = new Set<string>();
    let seen = 0;
    for (const e of cur.referrers) {
      if (++seen > 500) break;
      const f = e.fromNode;
      const name = f.name;
      if (f.type !== 'closure' || String(e.name_or_index) !== 'context')
        continue;
      if (SCOPE_RE.test(name) || LOG_SEGMENT_RE.test(name)) names.add(name);
    }
    return [...names].sort();
  }
  return [];
}

/**
 * Every diagnostic buffer, in one pass over the nodes. A buffer in another
 * realm than the main window (an extension, DevTools' isolated world) is
 * returned in `excluded`, not as a row.
 */
export function diagnosticBuffers(snapshot: IHeapSnapshot): {
  rows: DiagRow[];
  excluded: DiagExcluded[];
} {
  const perfs: IHeapNode[] = [];
  const errorArrays: IHeapNode[] = [];
  const perfArrays: IHeapNode[] = [];
  const queues: IHeapNode[] = [];
  // The main window's realm is the one with the most hidden classes.
  const mapsPerRealm = new Map<number, number>();
  let browser = false;
  snapshot.nodes.forEach((n: IHeapNode) => {
    const name = n.name;
    if (n.type === 'native') {
      if (name === 'Performance') perfs.push(n);
    } else if (name === 'system / Map') {
      const ctx = n
        .getReferenceNode('map', 'internal')
        ?.getReferenceNode('native_context', 'internal');
      if (ctx != null) {
        mapsPerRealm.set(ctx.id, (mapsPerRealm.get(ctx.id) ?? 0) + 1);
      }
    } else if (n.type === 'object' && COLLECTIONS.has(name)) {
      if (n.retainedSize >= MIN_BYTES) queues.push(n);
      if (name !== 'Array') return;
      const sample = sampleElements(n, 8);
      if (sample.filter(isErrorLike).length >= 4) errorArrays.push(n);
      else if (sample.filter(isPerfRecord).length >= 4) perfArrays.push(n);
    } else if (!browser && n.type === 'object' && name.startsWith('Window ')) {
      browser = true;
    }
  });
  const mainRealm = [...mapsPerRealm].sort((a, b) => b[1] - a[1])[0]?.[0];

  const labeler = cachedPathLabeler(snapshot);
  const holderOf = (n: IHeapNode) => {
    const path = labeler.labelOf(n);
    const held = heldByLabel(n, 48);
    const edge = /[.\s]([^.\s]+)(?: \(\+\d+\))?$/.exec(held)?.[1];
    return edge != null && path.endsWith(`.${edge}`)
      ? path
      : `${path} (${held})`;
  };
  const rows: DiagRow[] = [];
  const excluded: DiagExcluded[] = [];
  const seen = new Set<number>();
  /** Claims `n`; true when it belongs to another realm and is left out. */
  const claim = (n: IHeapNode, what: string): boolean => {
    seen.add(n.id);
    const ctx = browser ? realmOf(n) : null;
    if (ctx == null || mainRealm == null || ctx.id === mainRealm) return false;
    // A few hundred bytes of someone else's buffer is not worth a line.
    if (n.retainedSize >= 8 * 1024) {
      const url = /NativeContext \/ (.+)$/.exec(ctx.name)?.[1];
      const realm = `NativeContext@${ctx.id}${url != null ? ` (${url})` : ''}`;
      excluded.push({id: n.id, what, bytes: n.retainedSize, realm});
    }
    return true;
  };
  const push = (n: IHeapNode, row: Omit<DiagRow, 'id' | 'bytes' | 'key'>) =>
    rows.push({
      ...row,
      id: n.id,
      bytes: n.retainedSize,
      key: `${row.kind}|${row.holder}`,
    });

  for (const arr of errorArrays) {
    const errors = arrayElements(arr).filter(isErrorLike);
    if (errors.length < MIN_ERRORS) continue;
    if (claim(arr, `${formatNumber(errors.length)} error records`)) continue;
    const g = errorGroups(errors);
    push(arr, {
      kind: 'error history',
      holder: holderOf(arr),
      entries: errors.length,
      detail:
        `${formatNumber(g.distinct)} distinct message+stack; ` +
        `top "${g.topMessage}" ×${formatNumber(g.topCount)}` +
        (g.topVariants > 1 ? ` in ${g.topVariants} variants` : '') +
        (g.dupRecords > 0
          ? `; storing each distinct error once frees ${formatBytes(g.dupRecords)} (${formatBytes(g.dupText)} of it repeated message/stack text)`
          : ''),
    });
  }

  perfs.sort((a, b) => b.retainedSize - a.retainedSize);
  let timelines = 0;
  for (const perf of perfs) {
    const {entries, row} = timeline(perf);
    if (entries < 50 && perf.retainedSize < MIN_BYTES) continue;
    claim(perf, '');
    push(perf, {
      kind: 'perf timeline',
      holder: `Performance (native timeline${timelines++ > 0 ? ` #${timelines}` : ''})`,
      entries,
      detail: row.detail ?? '',
      types: row.types,
    });
  }
  for (const arr of perfArrays) {
    const recs = arrayElements(arr).filter(isPerfRecord);
    const n = recs.length;
    if (n < MIN_PERF_COPIES) continue;
    if (claim(arr, `${formatNumber(n)} performance-entry records`)) continue;
    const type = recs[0].name === 'Object' ? 'record' : recs[0].name;
    const res = type === 'PerformanceResourceTiming';
    push(arr, {
      kind: 'perf timeline',
      holder: holderOf(arr),
      entries: n,
      detail:
        `a JS array of ${type} entries` +
        (res && n === RESOURCE_BUFFER
          ? `, full at the default ${RESOURCE_BUFFER}: later entries are dropped until clearResourceTimings()`
          : res && n > RESOURCE_BUFFER
            ? `, above the default ${RESOURCE_BUFFER}-entry buffer`
            : ''),
    });
  }

  // Largest first, so a queue inside an accepted buffer is skipped.
  queues.sort((a, b) => b.retainedSize - a.retainedSize);
  const inside = (n: IHeapNode) => {
    let d = n.dominatorNode;
    for (let hops = 0; d != null && hops < 30; hops++, d = d.dominatorNode) {
      if (seen.has(d.id)) return true;
    }
    return false;
  };
  // Sibling queues of one owner (a trace's per-component sample arrays) are
  // one buffer, reported at their common dominator.
  const groups = new Map<
    number,
    Array<{q: IHeapNode; n: number; why: string}>
  >();
  for (const q of queues) {
    if (seen.has(q.id) || inside(q)) continue;
    const path = labeler.labelOf(q);
    let why = `${q.name} under a logging/telemetry name`;
    if (!isTelemetryName(`${path} ${heldByLabel(q, 48)}`)) {
      // Only the scope's function names say what it is: ask for two, and for
      // a named owner (Node internals sit under bare `root`).
      const scope = path === 'root' ? [] : scopeNames(q);
      if (scope.length < 2) continue;
      why = `${q.name} in the scope of ${scope.slice(0, 3).join(', ')}`;
    }
    const n = countEntries(q) ?? 0;
    if (n < 2 || claim(q, `${q.name} of ${formatNumber(n)}`)) continue;
    const dom = q.dominatorNode?.id ?? -q.id;
    groups.set(dom, [...(groups.get(dom) ?? []), {q, n, why}]);
  }
  for (const g of groups.values()) {
    const owner = g[0].q.dominatorNode;
    if (g.length === 1 || owner == null) {
      for (const {q, n, why} of g) {
        push(q, {
          kind: 'telemetry queue',
          holder: holderOf(q),
          entries: n,
          detail: why,
        });
      }
      continue;
    }
    const parts = g
      .slice(0, 4)
      .map(
        x =>
          `${heldByLabel(x.q, 40).replace(/^.*\./, '')} ${formatNumber(x.n)}`,
      );
    const holder = holderOf(owner);
    rows.push({
      kind: 'telemetry queue',
      holder,
      id: owner.id,
      entries: g.reduce((sum, x) => sum + x.n, 0),
      // Siblings in the dominator tree: their retained sizes add up.
      bytes: g.reduce((sum, x) => sum + x.q.retainedSize, 0),
      key: `telemetry queue|${holder}`,
      detail: `${g.length} collections under one owner (${parts.join(', ')}${g.length > 4 ? ', …' : ''})`,
    });
  }
  rows.sort((a, b) => b.bytes - a.bytes);
  excluded.sort((a, b) => b.bytes - a.bytes);
  return {rows, excluded};
}

/** `pick` of the same buffer at every rung, oldest first, as `a → b → c`. */
function series<T>(
  row: DiagRow,
  earlier: DiagRow[][],
  pick: (r: DiagRow) => T | undefined,
  fmt: (v: T) => string,
): string {
  const past = earlier.map(rs => rs.find(r => r.key === row.key));
  return [...past.map(r => (r != null ? pick(r) : undefined)), pick(row)]
    .map(v => (v != null ? fmt(v) : '—'))
    .join(' → ');
}

/** Entry types of a timeline that grew across the rungs. */
function typeGrowth(row: DiagRow, earlier: DiagRow[][]): string {
  const grown = Object.entries(row.types ?? {})
    .map(([type, n]) => {
      const first = earlier[0]?.find(r => r.key === row.key)?.types?.[type];
      return {type, delta: n - (first ?? 0)};
    })
    .filter(g => g.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 3)
    .map(
      g =>
        `${short(g.type)} ${series(row, earlier, r => r.types?.[g.type], formatNumber)}`,
    );
  return grown.length > 0 ? `. Grew: ${grown.join('; ')}` : '';
}

/**
 * The rows as markdown, `cap` rows at most; no lines when there is nothing.
 * `earlier` holds the rows of the earlier rungs, oldest first; with it, each
 * row shows its entries and bytes per rung.
 */
export function renderDiagnosticBuffers(
  result: {rows: DiagRow[]; excluded: DiagExcluded[]},
  cap: number,
  earlier: DiagRow[][] = [],
): string[] {
  const {rows, excluded} = result;
  const lines: string[] = [];
  const ladder = earlier.length > 0;
  if (rows.length > 0) {
    lines.push(
      markdownTable(
        [
          'Kind',
          'Holder',
          'Entries',
          ladder ? 'Held per rung' : 'Held',
          'What it holds',
        ],
        rows
          .slice(0, cap)
          .map(r => [
            r.kind,
            `${sanitizeForTable(shorten(r.holder, 70))} @${r.id}`,
            series(r, earlier, x => x.entries, formatNumber),
            series(r, earlier, x => x.bytes, formatBytes),
            sanitizeForTable(r.detail + (ladder ? typeGrowth(r, earlier) : '')),
          ]),
        new Set([2, 3]),
      ),
    );
    if (rows.length > cap) {
      lines.push(`_${rows.length - cap} more row(s) not shown._`);
    }
  }
  if (excluded.length > 0) {
    const shown = excluded
      .slice(0, 3)
      .map(x => `@${x.id} (${x.what}, ${formatBytes(x.bytes)}) in ${x.realm}`);
    const more = excluded.length > 3 ? ` and ${excluded.length - 3} more` : '';
    // A list item, so a terse session keeps it.
    lines.push(
      ...(lines.length > 0 ? [''] : []),
      `- Left out, not app memory: ${shown.join('; ')}${more}. Another realm than the main window owns these (an extension, or an isolated world such as DevTools').`,
    );
  }
  if (rows.length > 0) {
    lines.push(
      '',
      '_Held = retained bytes. A capped buffer still costs its Held bytes for as long as the page runs; the error-history dedupe figure is what keeping one record per distinct message+stack would free. Drill with memlab_object_shape / memlab_retainer_trace on the @id._',
    );
  }
  return lines;
}

/**
 * The section memlab_sweep prints: nothing when no buffer qualifies.
 * `earlier` are the rows of earlier rungs (`diagnosticBuffers(rung).rows`);
 * `skipIds` drops rows whose @id an earlier section already printed.
 */
export function diagnosticBuffersSweepSection(
  snapshot: IHeapSnapshot,
  opts: {
    earlier?: DiagRow[][];
    cap?: number;
    skipIds?: ReadonlySet<number>;
  } = {},
): string[] {
  const {rows, excluded} = diagnosticBuffers(snapshot);
  const kept = rows.filter(r => opts.skipIds?.has(r.id) !== true);
  // Every row already printed elsewhere in the sweep: no empty table.
  if (kept.length === 0) return [];
  const body = renderDiagnosticBuffers(
    {rows: kept, excluded},
    opts.cap ?? 6,
    opts.earlier ?? [],
  );
  if (body.length === 0) return [];
  return [
    '## Diagnostic buffers (error histories, Performance timeline, telemetry)',
    '',
    ...body,
    '',
  ];
}

export function registerDiagnosticBuffers(server: McpServer): void {
  server.tool(
    'memlab_diagnostic_buffers',
    "The app's own instrumentation buffers, which read as 'bounded' but still hold memory: (a) error histories, arrays of Error objects or {message, stack} records, grouped by exact message+stack, with the top repeated message and what keeping one record per distinct error would free; (b) the Performance timeline, buffered entries by entry type with counts and retained bytes, noting resource timing above the default 250-entry buffer, plus JS arrays of copied performance entries; (c) Arrays/Maps/Sets of 16 KB or more under logging/telemetry names (banzai, logger, telemetry, metrics, trace, batch, queue, expired, log). " +
      'Buffers in another realm than the main window (an extension, an isolated world) are left out and named. With `paths` (2 or more, oldest first) each row shows entries and bytes per rung; the last path becomes the active snapshot. One line when no buffer qualifies.',
    {
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Snapshot paths, OLDEST FIRST. Rows come from the last one; with 2 or more, every row shows its size per rung.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(12)
        .describe('Rows to show, largest first (default 12).'),
    },
    async ({paths, limit}) => {
      try {
        const earlier: DiagRow[][] = [];
        let header: string | undefined;
        if (paths != null && paths.length > 0) {
          const {rungs} = resolveRungs(paths);
          const last = rungs[rungs.length - 1];
          if ((await loadSnapshotByPath(last.localPath)) == null) {
            return errorResult(`Could not load ${last.localPath}.`);
          }
          for (const r of rungs.slice(0, -1)) {
            earlier.push(
              await withSnapshotAt(r.localPath, s => diagnosticBuffers(s).rows),
            );
          }
          header = pathsHeader(rungs.map(r => r.label));
        }
        const t0 = Date.now();
        const found = diagnosticBuffers(getSnapshot());
        const body = renderDiagnosticBuffers(found, limit, earlier);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        return toolResult(
          body.length === 0
            ? 'No diagnostic buffers: no error history of 10+ entries, no buffered Performance timeline, and no 16 KB+ collection under a logging/telemetry name.'
            : ['## Diagnostic buffers', '', ...body, `_Scan ${secs}s._`].join(
                '\n',
              ),
          header,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
