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
import {z} from 'zod';
import {findResidentByPath} from './heap-state.js';
import {loadRunManifest} from './run-manifest.js';
import {resolveLadderPaths} from './tools/ladder.js';

/**
 * Ladder tools that parse rung files, and so can run past the client's
 * foreground limit (~120 s). A call past it is moved to the background by the
 * client, and its result arrives later as a notification the agent cannot
 * chain on; as a job it can be collected with `memlab_job_status`.
 */
export const AUTO_JOB_TOOLS = new Set([
  'memlab_ladder_probe',
  'memlab_ab_compare',
  'memlab_eval_across',
  'memlab_pending_promises',
  'memlab_leak_report',
  'memlab_settle_check',
  'memlab_collection_diff',
  'memlab_replicate',
  'memlab_shape_census_diff',
  'memlab_sequence_analysis',
  'memlab_model_duplicates',
  'memlab_retained_errors',
  'memlab_eval',
]);

/** Parse plus a first pass, per MB of snapshot file not already in memory. */
const MS_PER_MB = 55;

export function autoJobThresholdMs(): number {
  const raw = process.env.MEMLAB_AUTO_JOB_MS;
  const n = raw == null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 90_000;
}

export function backgroundParam() {
  return z
    .boolean()
    .optional()
    .describe(
      'Default: run as a background job when the rungs left to parse predict more than 90 s, and return a job id at once (collect with `memlab_job_status({job_id, wait_ms: 90000})`). `false` always runs in the foreground; `true` always starts a job.',
    );
}

export interface RungEstimate {
  ms: number;
  toParse: number;
  cached: number;
}

function sizeMB(p: string): number | null {
  try {
    return fs.statSync(p).size / (1024 * 1024);
  } catch {
    try {
      // A pruned rung is read from its archive, ~4x the size inflated.
      return (fs.statSync(`${p}.gz`).size * 4) / (1024 * 1024);
    } catch {
      return null;
    }
  }
}

/** The rung files a call will read, from its `paths`, `run_dir` or `snapshot`. */
export function rungFilesOf(params: Record<string, unknown>): string[] {
  const out: string[] = [];
  const paths = params.paths;
  if (Array.isArray(paths) && paths.every(p => typeof p === 'string')) {
    try {
      out.push(...resolveLadderPaths(paths as string[]).paths);
    } catch {
      out.push(...(paths as string[]));
    }
  }
  const runDir = params.run_dir;
  if (typeof runDir === 'string' && runDir !== '' && out.length === 0) {
    try {
      const m = loadRunManifest(runDir);
      out.push(...m.paths);
      if (m.settleRungPath != null) out.push(m.settleRungPath);
    } catch {
      // The tool reports a bad run_dir itself.
    }
  }
  const snap = params.snapshot;
  if (typeof snap === 'string' && /\.heapsnapshot(\.gz)?$/.test(snap)) {
    out.push(snap);
  }
  return out;
}

export function estimateRungReads(files: readonly string[]): RungEstimate {
  let ms = 0;
  let toParse = 0;
  let cached = 0;
  for (const f of new Set(files)) {
    if (findResidentByPath(f) != null) {
      cached++;
      continue;
    }
    const mb = sizeMB(f);
    if (mb == null) continue;
    toParse++;
    ms += mb * MS_PER_MB;
  }
  return {ms: Math.round(ms), toParse, cached};
}

/**
 * The estimate when `name` should run as a job for these params, else null.
 * An explicit `background` (or a tool's own `async`) decides outright.
 */
export function shouldAutoJob(
  name: string,
  params: unknown,
): RungEstimate | null {
  if (!AUTO_JOB_TOOLS.has(name)) return null;
  if (params == null || typeof params !== 'object') return null;
  const p = params as Record<string, unknown>;
  if (p.background === false || p.async === false) return null;
  // A tool with its own `async` starts its own job.
  if (p.async === true) return null;
  const est = estimateRungReads(rungFilesOf(p));
  if (p.background === true) return est;
  const threshold = autoJobThresholdMs();
  return threshold > 0 && est.ms > threshold ? est : null;
}

export function autoJobReply(
  name: string,
  jobId: string,
  est: RungEstimate,
  forced: boolean,
): string {
  const eta = Math.max(1, Math.round(est.ms / 1000));
  return [
    `Started \`${name}\` as background job \`${jobId}\`` +
      (forced
        ? ' (`background: true`).'
        : `: ${est.toParse} rung(s) to parse${est.cached > 0 ? `, ${est.cached} cached` : ''}, predicted ~${eta} s, over the ${Math.round(autoJobThresholdMs() / 1000)} s foreground budget.`),
    '',
    `Collect it with \`memlab_job_status({job_id: "${jobId}", wait_ms: 90000})\`; its notes show each rung as it finishes. Pass \`background: false\` to run in the foreground instead.`,
  ].join('\n');
}
