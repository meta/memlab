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
import type {IHeapNode} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {fromResultParam, resolveSavedNodeIds} from '../result-handles.js';
import {
  enumerateMapEntries,
  enumerateSetElements,
  errorResult,
  formatBytes,
  formatNumber,
  heldByLabel,
  markdownTable,
  matchesPropertyShape,
  stratifyNodes,
  toolResult,
} from '../utils.js';
import {arrayElements} from './framework-buffers.js';

/** Records audited per call; a larger population is stratified down to this. */
const MAX_RECORDS = 200_000;
/** Distinct values remembered per field (enough for a stable top value). */
const MAX_DISTINCT = 5_000;

export interface FieldValue {
  kind: 'nullish' | 'string' | 'number' | 'object' | 'other';
  /** Equality key: the value for primitives, the node id for objects. */
  key: string;
  /** Decoded numeric value, when the capture recorded it. */
  num?: number;
  empty?: boolean;
  /** Object held by more than one node (another record or another holder). */
  shared?: boolean;
}

function propertyEdges(node: IHeapNode) {
  return [...node.references].filter(
    e => e.type === 'property' && String(e.name_or_index) !== '__proto__',
  );
}

/** Classify one field value. An Oddball carries its name on hidden edge `0`. */
export function classifyValue(t: IHeapNode): FieldValue {
  let name = t.name;
  if (name === 'system / Hole') name = 'undefined';
  if (name === 'system / Oddball') {
    const e = [...t.references].find(
      r => r.type === 'hidden' && String(r.name_or_index) === '0',
    );
    name = e?.toNode.name ?? 'null/undefined';
  }
  if (name === 'null' || name === 'undefined' || name === 'null/undefined') {
    return {kind: 'nullish', key: name};
  }
  if (name === 'true' || name === 'false') return {kind: 'other', key: name};
  if (t.isString) {
    let v = name;
    try {
      v = t.toStringNode()?.stringValue ?? name;
    } catch {
      // A rope with a non-string child: keep the node name.
    }
    // Keyed on (nearly) the whole value so strings sharing a prefix stay
    // distinct; the table cell truncates for display.
    return {kind: 'string', key: JSON.stringify(v.slice(0, 200)), empty: !v};
  }
  if (t.type === 'number') {
    // A capture with numeric values gives a number a `value` edge to a string
    // holding it; without one the value is not in the snapshot.
    for (const e of t.references) {
      if (String(e.name_or_index) !== 'value') continue;
      const num = Number(e.toNode.name);
      return Number.isFinite(num)
        ? {kind: 'number', key: String(num), num}
        : {kind: 'number', key: e.toNode.name};
    }
    return {kind: 'number', key: `#${t.id}`};
  }
  if (t.type !== 'object' && t.type !== 'closure' && t.type !== 'regexp') {
    return {kind: 'other', key: `${t.type}:${name}`};
  }
  const empty =
    name === 'Array'
      ? arrayElements(t).length === 0
      : name === 'Object' &&
        ![...t.references].some(
          e =>
            e.type === 'element' ||
            (e.type === 'property' && String(e.name_or_index) !== '__proto__'),
        );
  const holders = new Set<number>();
  for (const e of t.referrers) {
    if (e.type === 'weak' || e.type === 'shortcut') continue;
    holders.add(e.fromNode.id);
    if (holders.size > 1) break;
  }
  return {
    kind: 'object',
    key: `@${t.id} ${name}`,
    empty,
    shared: holders.size > 1,
  };
}

export interface FieldStat {
  name: string;
  present: number;
  nullish: number;
  empty: number;
  objects: number;
  shared: number;
  /** Bytes the records dominate through this field (freed if it went away). */
  ownedBytes: number;
  values: Map<string, number>;
  nums: number[];
  unreadableNums: number;
  /** A record where the field holds something, for drilling in. */
  example: number;
  exampleFilled: boolean;
}

/** Per-field fill statistics over a record population. */
export function auditFields(records: IHeapNode[]): Map<string, FieldStat> {
  const fields = new Map<string, FieldStat>();
  for (const rec of records) {
    const seen = new Set<string>();
    for (const e of propertyEdges(rec)) {
      const name = String(e.name_or_index);
      if (seen.has(name)) continue;
      seen.add(name);
      let f = fields.get(name);
      if (!f) {
        f = {
          name,
          ...{present: 0, nullish: 0, empty: 0, objects: 0, shared: 0},
          ...{ownedBytes: 0, unreadableNums: 0, nums: [], values: new Map()},
          ...{example: rec.id, exampleFilled: false},
        };
        fields.set(name, f);
      }
      const t = e.toNode;
      const v = classifyValue(t);
      f.present++;
      if (v.kind === 'nullish') f.nullish++;
      else if (!f.exampleFilled) {
        f.example = rec.id;
        f.exampleFilled = true;
      }
      if (v.empty) f.empty++;
      if (v.kind === 'object') f.objects++;
      if (v.shared) f.shared++;
      if (v.num != null) f.nums.push(v.num);
      else if (v.key.startsWith('#')) f.unreadableNums++;
      if (t.dominatorNode?.id === rec.id) f.ownedBytes += t.retainedSize;
      const c = f.values.get(v.key);
      if (c != null) f.values.set(v.key, c + 1);
      else if (f.values.size < MAX_DISTINCT) f.values.set(v.key, 1);
    }
  }
  return fields;
}

const TIME_WORDS = new Set(
  'time times timestamp stamp ts start started end ended date at since when expires expiration expiry created updated modified last'.split(
    ' ',
  ),
);

/** Whether a field name has a clock word (`startTime`, `created_at`, `end`). */
export function isTimeName(name: string): boolean {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-$.]+/)
    .some(w => TIME_WORDS.has(w.toLowerCase()));
}

const EPOCH_MIN = 946_684_800_000; // 2000-01-01
const EPOCH_MAX = 4_102_444_800_000; // 2100-01-01
const PERF_MAX = 1e10; // ~115 days of performance.now()

export type TimeScale = 'epoch ms' | 'epoch s' | 'performance.now() ms';

/**
 * Which clock a numeric field looks like it was read from, and its values in
 * ms on that clock (strays outside the range, a `0` sentinel say, dropped).
 * Epoch ms is taken on any name; epoch seconds (integers) and performance.now()
 * only on a time-like name, since counters share those ranges. Null unless
 * ≥95% of the values fit one clock.
 */
export function timestampScale(
  name: string,
  nums: number[],
): {scale: TimeScale; ms: number[]} | null {
  if (nums.length < 2) return null;
  const pick = (lo: number, hi: number, ints = false) =>
    nums.filter(n => n >= lo && n < hi && (!ints || Number.isInteger(n)));
  const fits = (vals: number[]) => vals.length / nums.length >= 0.95;
  const epochMs = pick(EPOCH_MIN, EPOCH_MAX);
  if (fits(epochMs)) return {scale: 'epoch ms', ms: epochMs};
  if (!isTimeName(name)) return null;
  const epochS = pick(EPOCH_MIN / 1000, EPOCH_MAX / 1000, true);
  if (fits(epochS)) return {scale: 'epoch s', ms: epochS.map(n => n * 1000)};
  const perf = pick(0, PERF_MAX);
  // A time-named field that never passes one minute is a duration, not a clock.
  return fits(perf) && perf.some(n => n >= 60_000)
    ? {scale: 'performance.now() ms', ms: perf}
    : null;
}

const AGE_BUCKETS: Array<[string, number]> = [
  ['≤1m', 60_000],
  ['1–10m', 600_000],
  ['10–60m', 3_600_000],
  ['1–6h', 21_600_000],
  ['6–24h', 86_400_000],
  ['>1d', Infinity],
];

function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 120) return `${s.toFixed(1)} s`;
  if (s < 7200) return `${(s / 60).toFixed(1)} min`;
  if (s < 172_800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86_400).toFixed(1)} d`;
}

/** Span, rate and an age histogram relative to the newest value. */
export function decodeTimes(nums: number[]) {
  let hi = -Infinity;
  let lo = Infinity;
  for (const n of nums) {
    if (n > hi) hi = n;
    if (n < lo) lo = n;
  }
  const counts = AGE_BUCKETS.map(() => 0);
  for (const n of nums) {
    counts[AGE_BUCKETS.findIndex(([, lim]) => hi - n <= lim)]++;
  }
  const span = hi - lo;
  return {
    min: lo,
    max: hi,
    span,
    perMin: span >= 1000 ? nums.length / (span / 60_000) : null,
    hist: AGE_BUCKETS.flatMap(([l], i) =>
      counts[i] ? [`${l} ${formatNumber(counts[i])}`] : [],
    ).join(' · '),
  };
}

function rate(perMin: number): string {
  return perMin < 10 ? perMin.toFixed(2) : formatNumber(Math.round(perMin));
}

function pct(n: number, d: number): string {
  if (n === 0) return '—';
  if (n / d < 0.001) return '<0.1%';
  if (n < d && n / d > 0.999) return '>99.9%';
  return `${((n / d) * 100).toFixed(n === d ? 0 : 1)}%`;
}

function fmtTime(v: number, scale: TimeScale): string {
  return scale === 'performance.now() ms'
    ? `${formatNumber(Math.round(v))} (${formatDuration(v)})`
    : new Date(v).toISOString().slice(0, 16).replace('T', ' ');
}

/** The record population, and a one-line description of where it lives. */
function resolveRecords(args: {
  node_id?: number;
  from_result?: string;
  className?: string;
  shape?: string[];
}): {records: IHeapNode[]; where: string; skipped: number} {
  const snapshot = getSnapshot();
  let candidates: IHeapNode[] = [];
  let where: string;
  if (args.node_id != null) {
    const c = snapshot.getNodeById(args.node_id);
    if (!c) throw new Error(`Node @${args.node_id} not found.`);
    let kind = 'property values';
    if (c.name === 'Map' || c.name === 'WeakMap') {
      kind = `${c.name} values`;
      candidates = enumerateMapEntries(c).flatMap(e => e.value ?? []);
    } else if (c.name === 'Set' || c.name === 'WeakSet') {
      kind = `${c.name} elements`;
      candidates = enumerateSetElements(c);
    } else if (c.name === 'Array') {
      kind = 'array elements';
      candidates = arrayElements(c);
    } else {
      candidates = [...c.references]
        .filter(
          e =>
            e.type === 'element' ||
            (e.type === 'property' && String(e.name_or_index) !== '__proto__'),
        )
        .map(e => e.toNode);
    }
    where = `${kind} of \`${c.name}\` @${c.id} (held as ${heldByLabel(c)}, ${formatBytes(c.retainedSize)} retained)`;
  } else if (args.from_result != null) {
    candidates = resolveSavedNodeIds(args.from_result).flatMap(
      id => snapshot.getNodeById(id) ?? [],
    );
    where = `saved result \`${args.from_result}\``;
  } else {
    const req = args.shape?.length ? new Set(args.shape) : null;
    snapshot.nodes.forEach(n => {
      if (n.type !== 'object' || n.id <= 3) return;
      if (args.className != null && n.name !== args.className) return;
      if (!req || matchesPropertyShape(n, req)) candidates.push(n);
    });
    where =
      (args.className != null ? `\`${args.className}\` instances` : 'objects') +
      (req ? ` with {${[...req].join(', ')}}` : '');
  }
  // A table of arrays (`{FeedUnit_1: [...], root: [...]}`): the records are
  // the arrays' elements, one level down.
  const arrays = candidates.filter(n => n.name === 'Array');
  if (arrays.length > 0 && arrays.length >= 0.9 * candidates.length) {
    candidates = arrays.flatMap(a => arrayElements(a));
    where = `elements of ${formatNumber(arrays.length)} arrays in ${where}`;
  }
  const records = candidates.filter(
    n => n.type === 'object' || n.type === 'closure',
  );
  return {records, where, skipped: candidates.length - records.length};
}

/** Notes on the field table: unset fields and per-record copies. */
function fieldNotes(sorted: FieldStat[], n: number): string[] {
  const notes: string[] = [];
  const unset = sorted.filter(f => f.nullish / n >= 0.99);
  if (unset.length > 0) {
    const names = unset.slice(0, 8).map(f => `\`${f.name}\``);
    notes.push(
      `${unset.length} of ${sorted.length} fields are null/undefined in ≥99% of records (${names.join(', ')}), so the records exist without carrying data in them. Check what is meant to set these fields, and whether a record is needed while it does not.`,
    );
  }
  for (const f of sorted) {
    const copied = f.objects - f.shared;
    if (f.objects >= 100 && f.objects >= n / 2 && copied >= 0.95 * f.objects) {
      if (f.ownedBytes === 0) continue;
      notes.push(
        `\`${f.name}\`: ${formatNumber(copied)} of ${formatNumber(f.objects)} object values have no holder but their record, so each record keeps its own copy (${formatBytes(f.ownedBytes)} owned). Check whether they could reference one shared value.`,
      );
    }
  }
  const unreadable = sorted.reduce((s, f) => s + f.unreadableNums, 0);
  if (unreadable > sorted.reduce((s, f) => s + f.nums.length, 0)) {
    notes.push(
      `${formatNumber(unreadable)} numeric values are not recorded in this capture (no numeric-value capture), so timestamps cannot be decoded, and small-integer fields have no edge at all: a field under 100% present may hold small integers in the other records.`,
    );
  }
  return notes;
}

/** The timestamp table and its notes; `scaleUp` corrects a sampled rate. */
function timeSection(
  sorted: FieldStat[],
  limit: number,
  scaleUp: number,
  notes: string[],
): string[] {
  const rows: string[][] = [];
  let ageNoted = false;
  let recentNoted = false;
  for (const f of sorted) {
    const ts = timestampScale(f.name, f.nums);
    if (!ts || rows.length >= limit) continue;
    const {scale, ms} = ts;
    const t = decodeTimes(ms);
    const perMin = t.perMin != null ? t.perMin * scaleUp : null;
    const dropped = f.nums.length - ms.length;
    rows.push([
      f.name,
      scale,
      formatNumber(ms.length) + (dropped ? ` (+${dropped} off-scale)` : ''),
      fmtTime(t.min, scale),
      fmtTime(t.max, scale),
      formatDuration(t.span),
      perMin == null ? '—' : rate(perMin) + (scaleUp > 1 ? '*' : ''),
      t.hist,
    ]);
    // A deadline is future-dated (start + timeout): it dates neither the
    // latest write nor how long the page has been open.
    if (/expir|deadline|due|timeout/i.test(f.name)) continue;
    const recent = ms.filter(v => t.max - v <= 60_000).length;
    if (!recentNoted && recent >= 10 && t.span > 600_000) {
      recentNoted = true;
      notes.push(
        `\`${f.name}\`: ${formatNumber(recent)} of ${formatNumber(ms.length)} ${scaleUp > 1 ? 'sampled ' : ''}values fall in the final minute before the newest (average ${rate(perMin ?? 0)}/min over ${formatDuration(t.span)}): the collection was still growing at the end of that span.`,
      );
    }
    if (scale === 'performance.now() ms' && !ageNoted) {
      ageNoted = true;
      notes.push(
        `Assuming \`${f.name}\` is performance.now() (ms since the page or process started), the newest value is ${formatDuration(t.max)}: it had been running at least that long when that record was written.`,
      );
    }
  }
  if (rows.length === 0) return [];
  return [
    '',
    '### Timestamp fields (ms; Age = before the newest value)',
    '',
    markdownTable(
      ['Field', 'Scale', 'Values', 'Min', 'Max', 'Span', 'Per min', 'Age'],
      rows,
      new Set([2, 6]),
    ),
    ...(scaleUp > 1
      ? [
          '',
          'Per min values marked * are scaled from the sample to all records.',
        ]
      : []),
  ];
}

export function registerFieldFill(server: McpServer): void {
  server.tool(
    'memlab_field_fill',
    "Field fill audit of a record population: what each field of the records actually holds. Target the records of ONE collection (`node_id`: Map values, Set/Array elements, or an Object's property values; a table of arrays is read one level down), a saved id set (`from_result`), or every instance of a class and/or shape. " +
      "Per field: % present, % null/undefined, the most common value and its share, % empty ([] / {} / ''), % of object values shared with another holder (vs a per-record copy), and the bytes the records own through it. " +
      'Numeric fields that look like timestamps (epoch ms on any name; epoch s or performance.now() ms on a time-like name) are decoded into min / max / span / records per minute and an age histogram relative to the newest value, when the capture recorded numeric values. ' +
      'Use it on a big table (a timing map, a task queue, a cache) to tell records that carry no data, or that each copy an array, from real content, and to see whether a collection was still being appended to.',
    {
      node_id: z
        .number()
        .optional()
        .describe(
          'The collection whose entries are the records (Map, Set, Array, or a plain Object used as a table).',
        ),
      from_result: fromResultParam(),
      class: z
        .string()
        .optional()
        .describe('Audit every instance of this class (node name).'),
      shape: z
        .array(z.string())
        .optional()
        .describe(
          'Audit every object having all these properties (combine with `class` to narrow).',
        ),
      limit_fields: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(20)
        .describe('Field rows to show (default 20).'),
    },
    async ({node_id, from_result, class: className, shape, limit_fields}) => {
      try {
        if (
          node_id == null &&
          from_result == null &&
          className == null &&
          !shape?.length
        ) {
          return toolResult(
            'Pass one of `node_id`, `from_result`, `class` or `shape`.',
          );
        }
        const {
          records: all,
          where,
          skipped,
        } = resolveRecords({
          node_id,
          from_result,
          className,
          shape,
        });
        if (all.length === 0) {
          return toolResult(`No object records found in ${where}.`);
        }
        const records = stratifyNodes(all, MAX_RECORDS);
        const n = records.length;
        const fields = auditFields(records);
        if (fields.size === 0) {
          return toolResult(
            `${formatNumber(all.length)} records in ${where}, none with named fields.`,
          );
        }
        const count = (m: Map<string, number>, k: string) =>
          m.set(k, (m.get(k) ?? 0) + 1);
        const top = (m: Map<string, number>, k = 3) =>
          [...m.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, k)
            .map(([c, v]) => `\`${c}\` ${formatNumber(v)}`)
            .join(', ') + (m.size > k ? ', …' : '');
        const classes = new Map<string, number>();
        const holders = new Map<string, number>();
        let selfBytes = 0;
        records.forEach((r, i) => {
          count(classes, r.name);
          selfBytes += r.self_size;
          // Without a container, name what holds a spread of the records.
          if (node_id == null && i % Math.ceil(n / 50) === 0) {
            count(holders, heldByLabel(r));
          }
        });
        const header = [
          `**Records** ${top(classes)}`,
          `self ${formatBytes(selfBytes)}`,
          `${formatNumber(fields.size)} distinct field(s)`,
          skipped ? `${formatNumber(skipped)} non-object entries skipped` : '',
          n < all.length
            ? `**audited a stratified sample of ${formatNumber(n)}**`
            : '',
        ];
        const lines = [
          `## Field fill: ${formatNumber(all.length)} records, ${where}`,
          '',
          header.filter(Boolean).join(' | '),
        ];
        if (holders.size > 0) {
          lines.push(`**Held as** (a spread of records): ${top(holders)}`);
        }
        const sorted = [...fields.values()].sort(
          (a, b) => b.ownedBytes - a.ownedBytes || b.present - a.present,
        );
        const rows = sorted.slice(0, limit_fields).map(f => {
          const [topKey, topCount] = [...f.values].reduce(
            (best, kv) => (kv[1] > best[1] ? kv : best),
            ['', 0],
          );
          const shown = topKey.length > 32 ? topKey.slice(0, 31) + '…' : topKey;
          return [
            f.name,
            pct(f.present, n),
            pct(f.nullish, n),
            topCount < 2
              ? 'all distinct'
              : topCount / n < 0.01
                ? 'mostly distinct'
                : `${shown} ${pct(topCount, n)}`,
            pct(f.empty, n),
            f.objects
              ? `${f.shared ? pct(f.shared, f.objects) : '0%'} of ${formatNumber(f.objects)}`
              : '—',
            f.ownedBytes ? formatBytes(f.ownedBytes) : '—',
            `@${f.example}`,
          ];
        });
        lines.push(
          '',
          markdownTable(
            [
              'Field',
              'Present',
              'Null/undef',
              'Top value',
              'Empty',
              'Shared objs',
              'Owned',
              'Example',
            ],
            rows,
            new Set([1, 2, 4, 6]),
          ),
        );
        if (fields.size > limit_fields) {
          lines.push(
            '',
            `… ${fields.size - limit_fields} more field(s); raise limit_fields to see them.`,
          );
        }
        const notes = fieldNotes(sorted, n);
        lines.push(...timeSection(sorted, limit_fields, all.length / n, notes));
        if (notes.length > 0) lines.push('', ...notes.map(s => `- ${s}`));
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
