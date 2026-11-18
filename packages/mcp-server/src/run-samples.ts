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
  time_origin?: number;
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

function requests(s: RunSample): number {
  return counter(s, 'xhr') + counter(s, 'fetch');
}

/**
 * Which document each good sample was read from. Page counters reset on a
 * reload, so every total is per document. `time_origin` names the document;
 * without it, a `reloaded` flag or a counter going backwards starts a new one.
 */
function documentsOf(rows: RunSample[]): number[] {
  const docs: number[] = [];
  let doc = 0;
  let origin: number | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const o = typeof r.time_origin === 'number' ? r.time_origin : null;
    const prev = i > 0 ? rows[i - 1] : null;
    if (prev != null) {
      const changed =
        o != null && origin != null
          ? o !== origin
          : r.reloaded === true || requests(r) < requests(prev);
      if (changed) {
        doc++;
      }
    }
    if (o != null) {
      origin = o;
    }
    docs.push(doc);
  }
  return docs;
}

/** Sum over documents of each document's last reading of `key`. */
function totalAcrossReloads(
  rows: RunSample[],
  docs: number[],
  key: keyof RunSample,
): number {
  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    if (i === rows.length - 1 || docs[i + 1] !== docs[i]) {
      total += counter(rows[i], key);
    }
  }
  return total;
}

/**
 * Requests made up to each sample, across reloads: within a document the
 * counter's increments, and a new document's first reading in full (its
 * counter started from zero at the reload).
 */
function cumulativeRequests(rows: RunSample[], docs: number[]): number[] {
  const out: number[] = [];
  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    const now = requests(rows[i]);
    if (i === 0) {
      total = 0;
    } else if (docs[i] !== docs[i - 1]) {
      total += now;
    } else {
      total += Math.max(0, now - requests(rows[i - 1]));
    }
    out.push(total);
  }
  return out;
}

function requestRatePerMin(
  rows: RunSample[],
  cum: number[],
  fromS: number,
  toS: number,
): number | null {
  const idx = [...rows.keys()].filter(
    i => rows[i].t_s >= fromS && rows[i].t_s <= toS,
  );
  if (idx.length < 2) {
    return null;
  }
  const first = idx[0];
  const last = idx[idx.length - 1];
  const span = rows[last].t_s - rows[first].t_s;
  return span > 0 ? ((cum[last] - cum[first]) * 60) / span : null;
}

/** Each document's top paths at its last reading, summed across documents. */
function topPathsAcrossReloads(
  rows: RunSample[],
  docs: number[],
): Array<[string, number]> {
  const by = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    if (i !== rows.length - 1 && docs[i + 1] === docs[i]) {
      continue;
    }
    for (const [p, n] of rows[i].top_paths ?? []) {
      by.set(p, (by.get(p) ?? 0) + n);
    }
  }
  return [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
}

interface RiseScan {
  maxRise: number;
  quietRise: string | null;
}

/**
 * Every window of at least RISE_WINDOW_S within one document: the steepest
 * rise, and the steepest one with no request in it. A window across a reload
 * compares two different heaps, so it is not a rise.
 */
function scanRises(rows: RunSample[], docs: number[], cum: number[]): RiseScan {
  const heaps = [...rows.keys()].filter(
    i => typeof rows[i].heap_mb === 'number',
  );
  let maxRise = 0;
  let quiet: {rise: number; i: number; j: number} | null = null;
  for (let a = 0; a < heaps.length; a++) {
    const i = heaps[a];
    for (let b = a + 1; b < heaps.length; b++) {
      const j = heaps[b];
      if (docs[j] !== docs[i]) {
        break;
      }
      const span = rows[j].t_s - rows[i].t_s;
      if (span < RISE_WINDOW_S) {
        continue;
      }
      const rise = ((rows[j].heap_mb ?? 0) - (rows[i].heap_mb ?? 0)) / span;
      maxRise = Math.max(maxRise, rise);
      if (
        rise >= QUIET_RISE_MB_PER_S &&
        cum[j] === cum[i] &&
        (quiet == null || rise > quiet.rise)
      ) {
        quiet = {rise, i, j};
      }
    }
  }
  return {
    maxRise,
    quietRise:
      quiet == null
        ? null
        : `HEAP RISING WITH NO REQUESTS: +${quiet.rise.toFixed(1)} MB/s from ${rows[quiet.i].t_s}s to ${rows[quiet.j].t_s}s, and the page made no XHR or fetch in that window`,
  };
}

export function summarizeSamples(rows: RunSample[]): SamplesSummary {
  const ok = rows.filter(r => r.error == null);
  const docs = documentsOf(ok);
  const cum = cumulativeRequests(ok, docs);
  const heaps = ok.filter(r => typeof r.heap_mb === 'number');
  const flags: string[] = [];
  const {maxRise, quietRise} = scanRises(ok, docs, cum);
  if (quietRise != null) {
    flags.push(quietRise);
  }
  const spanS = rows.length > 1 ? rows[rows.length - 1].t_s - rows[0].t_s : 0;
  if (spanS >= 120) {
    const firstMin = requestRatePerMin(ok, cum, rows[0].t_s, rows[0].t_s + 60);
    const end = rows[rows.length - 1].t_s;
    const lastMin = requestRatePerMin(ok, cum, end - 60, end);
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
  const total = (key: keyof RunSample) => totalAcrossReloads(ok, docs, key);
  return {
    count: rows.length,
    spanS,
    heapFirstMB: heaps[0]?.heap_mb ?? null,
    heapMaxMB:
      heaps.length > 0 ? Math.max(...heaps.map(r => r.heap_mb ?? 0)) : null,
    heapLastMB: heaps[heaps.length - 1]?.heap_mb ?? null,
    maxRiseMBPerS: maxRise,
    reloads: docs.length > 0 ? docs[docs.length - 1] : 0,
    failedSamples: rows.length - ok.length,
    requests: total('xhr') + total('fetch'),
    rejections: total('rejections'),
    errors: total('errors') + total('resource_errors'),
    consoleErrors: total('console_errors'),
    longTaskMs: total('long_task_ms'),
    topPaths: topPathsAcrossReloads(ok, docs),
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
