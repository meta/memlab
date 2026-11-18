/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import fs from 'fs';
import path from 'path';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {resolveRoundDir} from '../round-index.js';
import {errorResult, markdownTable, toolResult} from '../utils.js';
import {findIdleSibling} from './leak-report.js';

/**
 * Work without retention: a combo that fires requests, long tasks, rejections
 * or an error screen far more than the idle control does, whether or not the
 * heap grows. A request loop or a stuck error fallback leaves a flat heap, so
 * a leak report never shows it, but the samples taken between rungs do.
 */

interface Sample {
  t: number;
  label: string;
  doc: string;
  counters: Record<Counter, number>;
  errorUi: boolean;
}

const COUNTERS = [
  'requests',
  'resources',
  'http_errors',
  'resource_errors',
  'rejections',
  'long_task_ms',
] as const;
type Counter = (typeof COUNTERS)[number];

// Field names of the runner's sampler, then those of other samplers.
const ALIASES: Record<Counter, string[][]> = {
  requests: [['xhr', 'fetch']],
  resources: [['resources'], ['res']],
  http_errors: [['http_errors']],
  resource_errors: [['resource_errors'], ['resErr']],
  rejections: [['rejections']],
  long_task_ms: [['long_task_ms'], ['longTaskMs']],
};

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function counter(row: Record<string, unknown>, c: Counter): number {
  for (const keys of ALIASES[c]) {
    const vals = keys.map(k => num(row[k]));
    if (vals.some(v => v != null)) {
      return vals.reduce<number>((a, v) => a + (v ?? 0), 0);
    }
  }
  return 0;
}

export function parseSamples(text: string): Sample[] {
  const out: Sample[] = [];
  let doc = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.error != null) continue;
    const t = num(row.t) ?? num(row.t_s);
    if (t == null) continue;
    if (row.reloaded === true) doc++;
    const origin = row.time_origin ?? row.origin;
    out.push({
      t,
      label: String(row.tag ?? row.combo ?? '(untagged)'),
      doc: origin != null ? String(origin) : String(doc),
      counters: Object.fromEntries(
        COUNTERS.map(c => [c, counter(row, c)]),
      ) as Record<Counter, number>,
      errorUi: Number(row.error_ui ?? row.errUiNow ?? 0) > 0,
    });
  }
  return out;
}

export interface Activity {
  label: string;
  seconds: number;
  totals: Record<Counter, number>;
  errorUiSeconds: number;
}

/**
 * Per label, the counter increments between consecutive samples of one
 * document, credited to the later sample's label (what was driving when the
 * work happened). Counters reset on a reload, so a document change adds
 * nothing.
 */
export function activityByLabel(samples: Sample[]): Activity[] {
  const by = new Map<string, Activity>();
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const dt = b.t - a.t;
    if (dt <= 0 || a.doc !== b.doc) continue;
    let act = by.get(b.label);
    if (act == null) {
      act = {
        label: b.label,
        seconds: 0,
        totals: Object.fromEntries(COUNTERS.map(c => [c, 0])) as Record<
          Counter,
          number
        >,
        errorUiSeconds: 0,
      };
      by.set(b.label, act);
    }
    act.seconds += dt;
    if (b.errorUi) act.errorUiSeconds += dt;
    for (const c of COUNTERS) {
      act.totals[c] += Math.max(0, b.counters[c] - a.counters[c]);
    }
  }
  return [...by.values()];
}

function perMin(a: Activity, c: Counter): number {
  return a.seconds > 0 ? (60 * a.totals[c]) / a.seconds : 0;
}

function overall(acts: Activity[]): Activity {
  const total: Activity = {
    label: 'all',
    seconds: 0,
    totals: Object.fromEntries(COUNTERS.map(c => [c, 0])) as Record<
      Counter,
      number
    >,
    errorUiSeconds: 0,
  };
  for (const a of acts) {
    total.seconds += a.seconds;
    total.errorUiSeconds += a.errorUiSeconds;
    for (const c of COUNTERS) total.totals[c] += a.totals[c];
  }
  return total;
}

function readSamplesFile(dir: string): string | null {
  for (const name of ['samples.jsonl', 'fault_samples.jsonl']) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

interface RequestRow {
  path: string;
  count: number;
  status: Record<string, number>;
}

/** Paths and statuses from the per-rung request windows in run.json. */
export function topRequests(
  rungs: Array<{requests?: {top?: RequestRow[]}}>,
  limit: number,
): RequestRow[] {
  const by = new Map<string, RequestRow>();
  for (const r of rungs) {
    for (const row of r.requests?.top ?? []) {
      const cur = by.get(row.path) ?? {path: row.path, count: 0, status: {}};
      cur.count += row.count;
      for (const [s, n] of Object.entries(row.status ?? {})) {
        cur.status[s] = (cur.status[s] ?? 0) + n;
      }
      by.set(row.path, cur);
    }
  }
  return [...by.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

type RungRequests = Array<{requests?: {top?: RequestRow[]}}>;

/** run.json `rungs`, or none when there is no readable run.json. */
function readRungs(dir: string): RungRequests {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, 'run.json'), 'utf8'),
    ) as {rungs?: RungRequests};
    return manifest.rungs ?? [];
  } catch {
    return [];
  }
}

const RATIO_FLOOR = 0.5;
const LOOP_RATIO = 10;
const MAX_LOOP_WARNINGS = 3;

export function registerActivityReport(server: McpServer): void {
  server.tool(
    'memlab_activity_report',
    'Work without retention: per combo (or per sample tag), the request rate, resource errors, unhandled rejections, long-task time and time spent on an error screen, from the samples a round took between rungs (`samples.jsonl`). Rows are ranked by how far their rates sit above the idle control round (`baseline_run_dir`, or a sibling directory named `*idle*`), or above the round as a whole when there is none. A request loop or a stuck error fallback leaves the heap flat, so `memlab_leak_report` never shows it; this does. Also lists the most-requested paths with their HTTP statuses from the per-rung request windows in run.json.',
    {
      run_dir: z
        .string()
        .describe(
          'A leak-hunt round directory holding samples.jsonl, or a round name from the round index.',
        ),
      baseline_run_dir: z
        .string()
        .optional()
        .describe(
          'The idle control round. Default: a sibling directory named `*idle*`, if there is exactly one.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(10)
        .describe('Rows in each table (default 10).'),
    },
    async ({run_dir, baseline_run_dir, limit}) => {
      try {
        const dir = resolveRoundDir(run_dir);
        const file = readSamplesFile(dir);
        if (file == null) {
          return errorResult(
            new Error(
              `No samples.jsonl in ${dir}. The round has to sample between rungs (\`--sample-every\`).`,
            ),
          );
        }
        const acts = activityByLabel(
          parseSamples(fs.readFileSync(file, 'utf8')),
        ).filter(a => a.seconds > 0);
        if (acts.length === 0) {
          return errorResult(
            new Error(`${file} has fewer than two usable samples.`),
          );
        }
        const explicit = baseline_run_dir != null;
        const baseDir = explicit
          ? resolveRoundDir(baseline_run_dir)
          : findIdleSibling(dir);
        const baseFile = baseDir != null ? readSamplesFile(baseDir) : null;
        if (explicit && baseFile == null) {
          return errorResult(
            new Error(
              `No samples.jsonl in the baseline ${baseDir}; it cannot be the idle control.`,
            ),
          );
        }
        const control =
          baseFile != null
            ? overall(
                activityByLabel(
                  parseSamples(fs.readFileSync(baseFile, 'utf8')),
                ),
              )
            : null;
        // A control with no usable interval would put every ratio over the
        // floor alone: refused when asked for, skipped when found.
        if (explicit && control != null && control.seconds <= 0) {
          return errorResult(
            new Error(
              `${baseFile} has fewer than two usable samples; it cannot be the idle control.`,
            ),
          );
        }
        const useControl = control != null && control.seconds > 0;
        const base = useControl ? control : overall(acts);
        const against = useControl
          ? `the idle control ${path.basename(baseDir ?? '')}`
          : control != null
            ? `the round as a whole (the idle control ${path.basename(baseDir ?? '')} has no usable samples)`
            : 'the round as a whole (no idle control found)';
        const ratio = (a: Activity, c: Counter): number =>
          perMin(a, c) / Math.max(perMin(base, c), RATIO_FLOOR);
        const load = (a: Activity): number =>
          Math.max(ratio(a, 'requests'), ratio(a, 'resources'));
        const score = (a: Activity): number =>
          Math.max(
            load(a),
            ratio(a, 'http_errors'),
            ratio(a, 'resource_errors'),
            ratio(a, 'rejections'),
            ratio(a, 'long_task_ms') / 10,
          ) + (a.errorUiSeconds > 0 ? 1 : 0);
        const ranked = [...acts].sort((a, b) => score(b) - score(a));
        const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
        const lines = [
          `## Activity by combo — ${path.basename(dir)}`,
          '',
          `_Rates per minute of driving under each label, from ${path.basename(file)}; ratios against ${against}._`,
          '',
          markdownTable(
            [
              'Label',
              'Time',
              'XHR+fetch/min',
              'Resources/min',
              '× base',
              'HTTP errors',
              'Resource errors',
              'Rejections',
              'Long tasks ms/min',
              'Error screen',
            ],
            ranked
              .slice(0, limit)
              .map(a => [
                a.label,
                `${fmt(a.seconds)}s`,
                fmt(perMin(a, 'requests')),
                fmt(perMin(a, 'resources')),
                `×${fmt(load(a))}`,
                String(a.totals.http_errors),
                String(a.totals.resource_errors),
                String(a.totals.rejections),
                fmt(perMin(a, 'long_task_ms')),
                a.errorUiSeconds > 0 ? `${fmt(a.errorUiSeconds)}s` : '',
              ]),
            new Set([1, 2, 3, 4, 5, 6, 7, 8]),
          ),
          '',
        ];
        // Every looping label, not only the top row: an error ratio can
        // outrank a request loop. The worst loops first, so the cap below
        // never hides one behind milder ones.
        const loops = ranked
          .filter(a => load(a) >= LOOP_RATIO)
          .sort((a, b) => load(b) - load(a));
        for (const a of loops.slice(0, MAX_LOOP_WARNINGS)) {
          const rate = Math.max(perMin(a, 'requests'), perMin(a, 'resources'));
          lines.push(
            `⚠ **${a.label} makes ${fmt(rate)} requests/min, ×${fmt(load(a))} ${useControl ? 'the idle control' : 'the round average'}.** A loop of requests with a flat heap is work without retention.`,
          );
        }
        if (loops.length > MAX_LOOP_WARNINGS) {
          lines.push(
            `…and ${loops.length - MAX_LOOP_WARNINGS} more label(s) at ×${LOOP_RATIO} or more.`,
          );
        }
        if (loops.length > 0) lines.push('');
        const reqs = topRequests(readRungs(dir), limit);
        if (reqs.length > 0) {
          lines.push(
            '### Most-requested paths (per-rung request windows)',
            '',
            markdownTable(
              ['Path', 'Count', 'Status'],
              reqs.map(r => [
                r.path.length > 80 ? `${r.path.slice(0, 79)}…` : r.path,
                String(r.count),
                Object.entries(r.status)
                  .sort((a, b) => b[1] - a[1])
                  .map(([s, n]) => `${s} ×${n}`)
                  .join(', '),
              ]),
              new Set([1]),
            ),
            '',
          );
        }
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
