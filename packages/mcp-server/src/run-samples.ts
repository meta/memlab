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

/** One line of a hunt's `samples.jsonl`, as far as the summary reads it. */
export interface RunSample {
  t_s: number;
  heap_mb?: number;
  xhr?: number;
  fetch?: number;
  rejections?: number;
  errors?: number;
  resource_errors?: number;
  console_errors?: number;
  long_task_ms?: number;
  reloaded?: boolean;
  error?: string;
  top_paths?: Array<[string, number]>;
}

export interface SamplesSummary {
  count: number;
  spanS: number;
  heapFirstMB: number | null;
  heapMaxMB: number | null;
  heapLastMB: number | null;
  /** Steepest heap rise over any window of at least `windowS` seconds. */
  maxRiseMBPerS: number;
  reloads: number;
  failedSamples: number;
  requests: number;
  rejections: number;
  errors: number;
  consoleErrors: number;
  longTaskMs: number;
  topPaths: Array<[string, number]>;
  flags: string[];
}

const RISE_WINDOW_S = 30;
// A rise this steep with no request in the same window is the shape of a
// replay or retry loop that only allocates.
const QUIET_RISE_MB_PER_S = 1;
// Requests per minute: the last minute against the first, and a floor so a
// page that makes two requests a minute is not flagged for making twenty.
const STORM_RATIO = 10;
const STORM_MIN_PER_MIN = 60;

export function readSamples(runDir: string): RunSample[] | null {
  const file = path.join(runDir, 'samples.jsonl');
  if (!fs.existsSync(file)) {
    return null;
  }
  const out: RunSample[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    try {
      const row = JSON.parse(line) as RunSample;
      if (typeof row.t_s === 'number') {
        out.push(row);
      }
    } catch {
      // A line cut short by a killed process.
    }
  }
  return out;
}

function counter(s: RunSample, key: keyof RunSample): number {
  const v = s[key];
  return typeof v === 'number' ? v : 0;
}

/**
 * Page counters reset on a reload, so totals are summed per document: each
 * document's last reading.
 */
function totalAcrossReloads(rows: RunSample[], key: keyof RunSample): number {
  let total = 0;
  let last = 0;
  for (const r of rows) {
    if (r.error != null) {
      continue;
    }
    const v = counter(r, key);
    if (r.reloaded === true || v < last) {
      total += last;
    }
    last = v;
  }
  return total + last;
}

/**
 * Each OK row's XHR and fetch count since the first sample, summed per
 * document like `totalAcrossReloads`, and the number of reloads seen so far.
 * Both only grow, so two rows with equal values bound a window with no
 * request and no reload.
 */
function cumulativeRequests(
  ok: RunSample[],
): Map<RunSample, {requests: number; reloads: number}> {
  const out = new Map<RunSample, {requests: number; reloads: number}>();
  let total = 0;
  let reloads = 0;
  let lastXhr = 0;
  let lastFetch = 0;
  for (const r of ok) {
    const xhr = counter(r, 'xhr');
    const fetch = counter(r, 'fetch');
    const reloaded = r.reloaded === true || xhr < lastXhr || fetch < lastFetch;
    if (reloaded) {
      reloads++;
      total += xhr + fetch;
    } else {
      total += xhr - lastXhr + (fetch - lastFetch);
    }
    lastXhr = xhr;
    lastFetch = fetch;
    out.set(r, {requests: total, reloads});
  }
  return out;
}

function requestRatePerMin(
  ok: RunSample[],
  cumulative: Map<RunSample, {requests: number}>,
  fromS: number,
  toS: number,
) {
  const inWindow = ok.filter(r => r.t_s >= fromS && r.t_s <= toS);
  if (inWindow.length < 2) {
    return null;
  }
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  const span = last.t_s - first.t_s;
  if (span <= 0) {
    return null;
  }
  const delta =
    (cumulative.get(last)?.requests ?? 0) -
    (cumulative.get(first)?.requests ?? 0);
  return (delta * 60) / span;
}

/**
 * `top_paths` counts reset with each document, so each document's last
 * reading is merged with the others before ranking.
 */
function topPathsAcrossReloads(
  ok: RunSample[],
  cumulative: Map<RunSample, {reloads: number}>,
): Array<[string, number]> {
  const lastPerDocument = new Map<number, Array<[string, number]>>();
  let limit = 0;
  for (const r of ok) {
    if (r.top_paths == null) {
      continue;
    }
    lastPerDocument.set(cumulative.get(r)?.reloads ?? 0, r.top_paths);
    limit = Math.max(limit, r.top_paths.length);
  }
  const merged = new Map<string, number>();
  for (const paths of lastPerDocument.values()) {
    for (const [p, n] of paths) {
      merged.set(p, (merged.get(p) ?? 0) + n);
    }
  }
  return [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

export function summarizeSamples(rows: RunSample[]): SamplesSummary {
  const ok = rows.filter(r => r.error == null);
  const heaps = ok.filter(r => typeof r.heap_mb === 'number');
  const cumulative = cumulativeRequests(ok);
  const flags: string[] = [];
  let maxRise = 0;
  let quietRise: string | null = null;
  for (let i = 0; i < heaps.length; i++) {
    const from = cumulative.get(heaps[i]);
    for (let j = i + 1; j < heaps.length; j++) {
      const span = heaps[j].t_s - heaps[i].t_s;
      if (span < RISE_WINDOW_S) {
        continue;
      }
      const rise = ((heaps[j].heap_mb ?? 0) - (heaps[i].heap_mb ?? 0)) / span;
      if (rise > maxRise) {
        maxRise = rise;
      }
      const to = cumulative.get(heaps[j]);
      const noRequests =
        from != null &&
        to != null &&
        to.reloads === from.reloads &&
        to.requests === from.requests;
      if (quietRise == null && rise >= QUIET_RISE_MB_PER_S && noRequests) {
        quietRise = `HEAP RISING WITH NO REQUESTS: +${rise.toFixed(1)} MB/s from ${heaps[i].t_s}s to ${heaps[j].t_s}s, and the page made no XHR or fetch in that window`;
      }
    }
  }
  if (quietRise != null) {
    flags.push(quietRise);
  }
  const spanS = rows.length > 1 ? rows[rows.length - 1].t_s - rows[0].t_s : 0;
  if (spanS >= 120) {
    const firstMin = requestRatePerMin(
      ok,
      cumulative,
      rows[0].t_s,
      rows[0].t_s + 60,
    );
    const end = rows[rows.length - 1].t_s;
    const lastMin = requestRatePerMin(ok, cumulative, end - 60, end);
    if (
      firstMin != null &&
      lastMin != null &&
      lastMin >= STORM_MIN_PER_MIN &&
      lastMin >= STORM_RATIO * Math.max(firstMin, 1)
    ) {
      flags.push(
        `REQUEST RATE: ${lastMin.toFixed(0)}/min in the last minute against ${firstMin.toFixed(0)}/min in the first`,
      );
    }
  }
  return {
    count: rows.length,
    spanS,
    heapFirstMB: heaps[0]?.heap_mb ?? null,
    heapMaxMB:
      heaps.length > 0 ? Math.max(...heaps.map(r => r.heap_mb ?? 0)) : null,
    heapLastMB: heaps[heaps.length - 1]?.heap_mb ?? null,
    maxRiseMBPerS: maxRise,
    reloads: ok.filter(r => r.reloaded === true).length,
    failedSamples: rows.length - ok.length,
    requests: totalAcrossReloads(ok, 'xhr') + totalAcrossReloads(ok, 'fetch'),
    rejections: totalAcrossReloads(ok, 'rejections'),
    errors:
      totalAcrossReloads(ok, 'errors') +
      totalAcrossReloads(ok, 'resource_errors'),
    consoleErrors: totalAcrossReloads(ok, 'console_errors'),
    longTaskMs: totalAcrossReloads(ok, 'long_task_ms'),
    topPaths: topPathsAcrossReloads(ok, cumulative),
    flags,
  };
}

/** The leak report's "Between rungs" section, or null without samples. */
export function samplesSection(
  runDir: string,
  runaway: string | null,
): string[] | null {
  const rows = readSamples(runDir);
  if (rows == null || rows.length === 0) {
    return null;
  }
  const s = summarizeSamples(rows);
  const mb = (v: number | null) => (v == null ? '?' : `${v.toFixed(1)} MB`);
  const lines = [
    '### Between rungs (samples.jsonl)',
    '',
    `${s.count} samples over ${s.spanS.toFixed(0)}s: heap ${mb(s.heapFirstMB)} → max ${mb(s.heapMaxMB)} → ${mb(s.heapLastMB)}, steepest rise ${s.maxRiseMBPerS.toFixed(2)} MB/s over ≥${RISE_WINDOW_S}s. ${s.reloads} reload(s), ${s.failedSamples} failed sample(s).`,
    `${s.requests} XHR/fetch, ${s.rejections} unhandled rejection(s), ${s.errors} error event(s), ${s.consoleErrors} console.error call(s), ${(s.longTaskMs / 1000).toFixed(1)}s of long tasks.` +
      (s.topPaths.length > 0
        ? ` Top paths: ${s.topPaths.map(([p, n]) => `\`${p}\` ×${n}`).join(', ')}.`
        : ''),
  ];
  const flags = runaway != null ? [`RUNAWAY: ${runaway}`, ...s.flags] : s.flags;
  for (const flag of flags) {
    lines.push(`- ⚠ **${flag}**`);
  }
  lines.push('');
  return lines;
}
