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
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'fs';
import memlabCore from '@memlab/core';
import memlabHeapAnalysis from '@memlab/heap-analysis';
import {z} from 'zod';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  matchesPropertyShape,
  pathsHeader,
  toolResult,
} from '../utils.js';
import {countEntries, parseLocator, resolvePath} from './collection-trend.js';
import {resolveLadderPaths} from './ladder.js';
import {resolveMaxFileSizeMB, resolveSnapshotPath} from './load-snapshot.js';
import {fitSlope, rateVerdict} from '../slope-stats.js';
import {
  NOISE_FLOOR_MAX_AGE_DAYS,
  readNoiseFloor,
  recordNoiseFloor,
} from '../noise-ledger.js';
import type {SlopeFit} from '../slope-stats.js';

const {utils: memlabUtils} = memlabCore;
const {getFullHeapFromFile} = memlabHeapAnalysis;

type MetricKind =
  | 'collection_length'
  | 'class_count'
  | 'pending_chain'
  | 'shape_count'
  | 'shape_self_bytes'
  | 'retained_size';

/**
 * `retained_size` is the only metric that needs the dominator pass; every other
 * one is read off names and edges. Kept as a predicate rather than inlined so
 * the light/full decision is made in exactly one place — a light snapshot
 * returns 0 for `retainedSize` WITHOUT failing, which is the silent-zero trap
 * the eval pre-flight already guards against.
 */
function needsRetainedSizes(kind: MetricKind): boolean {
  return kind === 'retained_size';
}

/** `"a, b,c"` -> `Set{a, b, c}`. Empty entries dropped. */
function parseShapeLocator(locator: string): Set<string> {
  return new Set(
    locator
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  );
}

// Guard against a corrupt or genuinely circular chain. V8's update queues ARE
// circular (`queue.pending.next` loops back), so the walk stops on a repeat as
// well — the cap only catches a chain longer than any real one.
const MAX_CHAIN = 100_000;

/**
 * Measure the metric on one parsed snapshot. One scalar per snapshot is the
 * whole point: the arms are compared on a rate, and a rate needs a number per
 * rung, not a report.
 */
export function measureMetric(
  snapshot: IHeapSnapshot,
  kind: MetricKind,
  locator: string,
  chainEdge: string,
): number {
  if (kind === 'class_count') {
    const want = locator.trim();
    let count = 0;
    snapshot.nodes.forEach(node => {
      if (node.id > 3 && node.name === want) count++;
    });
    return count;
  }

  if (kind === 'shape_count' || kind === 'shape_self_bytes') {
    const required = parseShapeLocator(locator);
    let total = 0;
    snapshot.nodes.forEach(node => {
      if (!matchesPropertyShape(node, required)) return;
      total += kind === 'shape_count' ? 1 : node.self_size;
    });
    return total;
  }

  if (kind === 'retained_size') {
    // The single largest instance, not the sum: the metric the leak-hunt
    // methodology asks you to quote is "the retained size of the object the fix
    // targets", and summing retained sizes over instances that nest on the
    // dominator tree double-counts.
    const want = locator.trim();
    let largest = 0;
    snapshot.nodes.forEach(node => {
      if (node.id <= 3 || node.name !== want) return;
      if (node.retainedSize > largest) largest = node.retainedSize;
    });
    return largest;
  }

  const loc = parseLocator(locator);
  let total = 0;
  snapshot.nodes.forEach(node => {
    if (node.id <= 3 || node.name !== loc.ownerClass) return;
    const target = resolvePath(node, loc.path);
    if (target == null) return;
    if (kind === 'collection_length') {
      total += countEntries(target) ?? 0;
      return;
    }
    // pending_chain: follow the linked list from the head, counting nodes.
    let cur: IHeapNode | null = target;
    const seen = new Set<number>();
    let len = 0;
    while (cur && !seen.has(cur.id) && len < MAX_CHAIN) {
      seen.add(cur.id);
      len++;
      let next: IHeapNode | null = null;
      for (const edge of cur.references) {
        if (edge.type === 'hidden') continue;
        if (String(edge.name_or_index) !== chainEdge) continue;
        next = edge.toNode.id > 3 ? edge.toNode : null;
        break;
      }
      cur = next;
    }
    total += len;
  });
  return total;
}

async function measureArm(
  paths: string[],
  kind: MetricKind,
  locator: string,
  chainEdge: string,
  maxFileSizeMB?: number,
): Promise<{labels: string[]; values: number[]}> {
  const labels: string[] = [];
  const values: number[] = [];
  for (const p of paths) {
    let local: string;
    let fetchedFrom: string | null = null;
    try {
      const r = resolveSnapshotPath(p);
      local = r.localPath;
      fetchedFrom = r.fetchedFrom;
    } catch (e) {
      throw new Error(
        `Failed to resolve "${p}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!fs.existsSync(local)) throw new Error(`File not found: ${local}`);
    const sizeMB = fs.statSync(local).size / (1024 * 1024);
    const limit = resolveMaxFileSizeMB(maxFileSizeMB, fetchedFrom != null);
    if (sizeMB > limit) {
      throw new Error(
        `${p} is ${sizeMB.toFixed(0)} MB — exceeds the ${limit} MB per-file safety limit. Raise it with max_file_size_mb: ${Math.ceil(sizeMB + 100)}.`,
      );
    }
    // Light parse by default: most metrics are read off names and edges, so the
    // dominator/retained-size pass would be paid on every rung of both arms for
    // nothing. `retained_size` is the exception and must have it — on a light
    // snapshot `retainedSize` reads back 0 WITHOUT failing, so a silent zero
    // would be reported as "the fix removed everything", which is the most
    // damaging possible wrong answer from a fix-verification tool.
    const snapshot = needsRetainedSizes(kind)
      ? await getFullHeapFromFile(local)
      : await memlabUtils.getSnapshotFromFile(local, {
          buildNodeIdIndex: true,
          verbose: false,
        });
    labels.push(fetchedFrom ?? p.replace(/^.*\//, ''));
    values.push(measureMetric(snapshot, kind, locator, chainEdge));
  }
  return {labels, values};
}

/**
 * Least-squares growth per interaction cycle across an arm's ladder, with its
 * 95% interval. Rung i sits at i * cycles, so every rung contributes, not only
 * the two ends.
 */
export function armSlope(values: number[], cycles: number): SlopeFit {
  return fitSlope(
    values.map((_, i) => i * cycles),
    values,
  );
}

export function registerVerifyFix(server: McpServer): void {
  server.tool(
    'memlab_verify_fix',
    'Decide whether a fix actually worked, by comparing the per-cycle growth RATE of one metric between a before ladder and an after ladder. hunt_runner --ab drives both arms but nothing analyses them, which is why fix write-ups stall at "A/B pending". ' +
      'NO RUNTIME GATE IS REQUIRED: the two arms are two sets of snapshot files passed as `before_paths` and `after_paths`, so a fix that cannot be put behind a flag — a build-only change, a local patch, a reverted commit — is verified exactly the same way. One session concluded this tool was unusable for an ungated fix and skipped A/B entirely; it is not. ' +
      'Metrics: "collection_length" (entries under "<OwnerClass>.<property>"), "class_count" (instances of a class), "pending_chain" (total length of the linked lists hanging off "<OwnerClass>.<property>", following `next` — the React update-queue shape), ' +
      '"shape_count" and "shape_self_bytes" (objects carrying ALL of a comma-separated property set — use these when the leaking population is anonymous object literals, whose class name is the useless "Object"; this is the common case for record types and the reason a session with a real A/B still had to hand-roll the comparison), ' +
      '"retained_size" (retained size of the LARGEST instance of a class — the figure the leak-hunt methodology asks you to quote for a fix, rather than aggregate heap). ' +
      'Note "retained_size" forces a FULL parse of every rung on both arms because retained sizes need the dominator pass; the other metrics load LIGHT. ' +
      'Compares RATES, not levels: a build difference, a warmer cache or a longer session all shift the absolute level, and only the slope per interaction says whether the thing still accumulates. Each arm therefore needs at least 2 rungs — a single snapshot per arm is refused rather than compared, because that comparison is confounded. ' +
      "Each rate is a least-squares slope over every rung, with a 95% interval from the residuals. The verdict is FIX CONFIRMED (the fixed arm's whole interval is at or under the residual rate expected_reduction allows), FIX FALLS SHORT (its whole interval is above it) or INCONCLUSIVE, with the reason: fewer than 3 rungs in an arm (a two-point slope has no error bar), a before arm whose own interval reaches zero, or an interval that crosses the threshold, in which case it also prints the largest reduction this run can confirm. More rungs on the same ladders narrow the interval; no extra ladders are needed. " +
      "Optional `before_repeat_paths`: a second, independently driven ladder of the UNFIXED build. Residuals within one ladder cannot see run-to-run drift; the two unfixed slopes can. Their spread widens the fixed arm's interval on both sides, and a spread as large as the reduction under test makes the verdict INCONCLUSIVE (run-to-run noise as large as the effect). Costs one more ladder parse, only when given. " +
      'Optional `setup_name` (a name you choose for the app, build mode and machine, e.g. "example.com prod-like devbox-1"): with `before_repeat_paths`, the spread is recorded for that setup and metric; without, a spread recorded for it in the last 14 days is reused, so the extra ladder is paid once per setup rather than once per fix. ' +
      'Returns both series, both rates and intervals, the reduction and the verdict. Loads rungs transiently in LIGHT mode, one graph at a time.',
    {
      metric_kind: z
        .enum([
          'collection_length',
          'class_count',
          'pending_chain',
          'shape_count',
          'shape_self_bytes',
          'retained_size',
        ])
        .describe('What to measure on every rung of both arms.'),
      locator: z
        .string()
        .describe(
          'For collection_length / pending_chain: "<OwnerClass>.<property>" (deeper paths allowed). For class_count and retained_size: the class name alone. For shape_count / shape_self_bytes: a comma-separated property set, e.g. "timeToFirstByte,timeToLastByte,transferSize" — matching is the same as memlab_find_by_shape, so the population counted here is the population that tool finds.',
        ),
      before_paths: z
        .array(z.string())
        .describe(
          'Ordered rungs of the UNFIXED arm, oldest first. A single ["ladder:<name>"] element expands to a saved ladder.',
        ),
      after_paths: z
        .array(z.string())
        .describe('Ordered rungs of the FIXED arm, oldest first.'),
      before_repeat_paths: z
        .array(z.string())
        .optional()
        .describe(
          'Optional same-build check: ordered rungs of a SECOND, independently driven ladder of the UNFIXED build (a separate run, not more rungs of the same session), same cycles between rungs.',
        ),
      setup_name: z
        .string()
        .optional()
        .describe(
          'Optional name for where the ladders were driven (app, build mode, machine). Records the run-to-run spread for it when `before_repeat_paths` is given, and reuses a recent one when it is not.',
        ),
      cycles: z
        .number()
        .describe(
          'Interaction cycles driven between consecutive rungs. Must be the same for both arms — otherwise the rates are not comparable.',
        ),
      expected_reduction: z
        .number()
        .optional()
        .default(0.9)
        .describe(
          'Fraction of the before-rate the fix is expected to remove, 0–1 (default 0.9). A leak fix should drive the rate to ~0; a sizing fix will not.',
        ),
      chain_edge: z
        .string()
        .optional()
        .default('next')
        .describe(
          'Edge name to follow for metric_kind "pending_chain" (default "next").',
        ),
      max_file_size_mb: z
        .number()
        .optional()
        .describe('Per-file size limit override (MB).'),
    },
    async ({
      metric_kind,
      locator,
      before_paths,
      after_paths,
      before_repeat_paths,
      setup_name,
      cycles,
      expected_reduction,
      chain_edge,
      max_file_size_mb,
    }) => {
      try {
        const before = resolveLadderPaths(before_paths).paths;
        const after = resolveLadderPaths(after_paths).paths;
        const repeatPaths = before_repeat_paths
          ? resolveLadderPaths(before_repeat_paths).paths
          : null;
        // Name BOTH arms: this tool never reads the resident snapshot, and a
        // fix-validation result labelled with an unrelated capture is the
        // worst place to leave a reader guessing which build was measured.
        const armsHeader = pathsHeader([
          ...before.map(p => `before:${p.replace(/^.*\//, '')}`),
          ...after.map(p => `after:${p.replace(/^.*\//, '')}`),
          ...(repeatPaths ?? []).map(p => `repeat:${p.replace(/^.*\//, '')}`),
        ]);
        for (const [label, arm] of [
          ['before_paths', before],
          ['after_paths', after],
          ...(repeatPaths
            ? [['before_repeat_paths', repeatPaths] as const]
            : []),
        ] as const) {
          if (arm.length < 2) {
            return errorResult(
              `${label} has ${arm.length} rung(s); each arm needs at least 2. This tool compares per-cycle RATES, and one snapshot gives a level, not a rate — comparing levels across two builds is confounded by warmup, session length and build differences.`,
            );
          }
        }
        if (cycles <= 0) {
          return errorResult('cycles must be greater than 0.');
        }
        if (expected_reduction < 0 || expected_reduction > 1) {
          return errorResult('expected_reduction must be between 0 and 1.');
        }

        const b = await measureArm(
          before,
          metric_kind,
          locator,
          chain_edge,
          max_file_size_mb,
        );
        const a = await measureArm(
          after,
          metric_kind,
          locator,
          chain_edge,
          max_file_size_mb,
        );

        const repeatArm = repeatPaths
          ? await measureArm(
              repeatPaths,
              metric_kind,
              locator,
              chain_edge,
              max_file_size_mb,
            )
          : null;

        const beforeFit = armSlope(b.values, cycles);
        const afterFit = armSlope(a.values, cycles);
        const beforeRate = beforeFit.slope;
        const afterRate = afterFit.slope;
        const repeatFit = repeatArm ? armSlope(repeatArm.values, cycles) : null;
        let repeatSpread = repeatFit
          ? Math.abs(repeatFit.slope - beforeRate)
          : 0;

        // Byte-valued metrics read as nonsense in raw counts — "1162420" is not
        // a number anyone checks, "1.1 MB" is.
        const isBytes =
          metric_kind === 'shape_self_bytes' || metric_kind === 'retained_size';
        const fmtVal = (v: number): string =>
          isBytes ? formatBytes(v) : formatNumber(v);
        const fmtRate = (r: number): string =>
          isBytes
            ? Math.round(r) < 0
              ? `-${formatBytes(Math.round(-r))}`
              : `${formatBytes(Math.max(0, Math.round(r)))}`
            : Math.abs(r) < 10
              ? (Math.abs(r) < 0.005 ? 0 : r).toFixed(2)
              : formatNumber(Math.round(r));
        const fmtInterval = (f: SlopeFit): string =>
          f.lo == null || f.hi == null
            ? 'none (2 rungs)'
            : `${fmtRate(f.lo)} … ${fmtRate(f.hi)}`;

        const lines: string[] = [
          `## Fix verification — \`${metric_kind}\` on \`${locator}\``,
          '',
          markdownTable(
            [
              'Arm',
              'Rungs',
              'First',
              'Last',
              'Net',
              'Per cycle',
              '95% interval',
            ],
            [
              [
                'before (unfixed)',
                String(b.values.length),
                fmtVal(b.values[0]),
                fmtVal(b.values[b.values.length - 1]),
                fmtVal(b.values[b.values.length - 1] - b.values[0]),
                fmtRate(beforeRate),
                fmtInterval(beforeFit),
              ],
              [
                'after (fixed)',
                String(a.values.length),
                fmtVal(a.values[0]),
                fmtVal(a.values[a.values.length - 1]),
                fmtVal(a.values[a.values.length - 1] - a.values[0]),
                fmtRate(afterRate),
                fmtInterval(afterFit),
              ],
              ...(repeatArm && repeatFit
                ? [
                    [
                      'before, repeated',
                      String(repeatArm.values.length),
                      fmtVal(repeatArm.values[0]),
                      fmtVal(repeatArm.values[repeatArm.values.length - 1]),
                      fmtVal(
                        repeatArm.values[repeatArm.values.length - 1] -
                          repeatArm.values[0],
                      ),
                      fmtRate(repeatFit.slope),
                      fmtInterval(repeatFit),
                    ],
                  ]
                : []),
            ],
            new Set([1, 2, 3, 4, 5]),
          ),
          '',
          `- before series: ${b.values.map(v => fmtVal(v)).join(' → ')}`,
          `- after series: ${a.values.map(v => fmtVal(v)).join(' → ')}`,
          ...(repeatArm
            ? [
                `- repeat series: ${repeatArm.values.map(v => fmtVal(v)).join(' → ')}`,
                `- run-to-run spread: the two unfixed ladders differ by ${fmtRate(repeatSpread)} per cycle; the fixed arm's interval is widened by that on both sides.`,
              ]
            : []),
          '',
        ];

        if (beforeRate <= 0) {
          lines.push(
            `⚠ **INCONCLUSIVE — the BEFORE arm does not grow** (rate ${fmtRate(beforeRate)}/cycle). There is nothing for the fix to reduce, so this run cannot validate it. The unfixed arm has to reproduce the leak first: check the metric and locator, drive more cycles, or confirm the arm really is running the unfixed build.`,
          );
          return toolResult(lines.join('\n'), armsHeader);
        }

        const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
        const setupName = setup_name?.trim() || null;
        if (setupName != null && repeatFit) {
          const relative = repeatSpread / beforeRate;
          const err = await recordNoiseFloor({
            setup: setupName,
            metric_kind,
            locator,
            relative_spread: relative,
            recorded_at: new Date().toISOString(),
          });
          lines.push(
            err == null
              ? `- run-to-run spread recorded for setup "${setupName}": ${pct(relative)} of the before rate. Checks on this setup and metric reuse it for ${NOISE_FLOOR_MAX_AGE_DAYS} days.`
              : `- run-to-run spread NOT recorded for setup "${setupName}": ${err}`,
            '',
          );
        } else if (setupName != null) {
          const floor = readNoiseFloor(setupName, metric_kind, locator);
          if (floor != null) {
            repeatSpread = floor.relative_spread * beforeRate;
            lines.push(
              `- run-to-run spread from the noise ledger for setup "${setupName}": ${pct(floor.relative_spread)} of the before rate (${fmtRate(repeatSpread)} per cycle here), recorded ${floor.recorded_at.slice(0, 10)}. The fixed arm's interval is widened by that on both sides.`,
              '',
            );
          } else {
            lines.push(
              `- No run-to-run spread on record for setup "${setupName}" and this metric in the last ${NOISE_FLOOR_MAX_AGE_DAYS} days, so the interval covers scatter within each ladder only. Pass \`before_repeat_paths\` once to record one.`,
              '',
            );
          }
        }

        const reduction = (beforeRate - afterRate) / beforeRate;
        const v = rateVerdict(
          beforeFit,
          afterFit,
          expected_reduction,
          repeatSpread,
        );
        const judged =
          afterFit.lo == null || afterFit.hi == null || repeatSpread === 0
            ? fmtInterval(afterFit)
            : // Widened down to zero, not past it, unless the arm's own
              // interval already reached below zero.
              `${fmtRate(Math.max(afterFit.lo - repeatSpread, Math.min(afterFit.lo, 0)))} … ${fmtRate(afterFit.hi + repeatSpread)}, with the run-to-run spread`;
        lines.push(
          `**Reduction: ${pct(reduction)}** of the before-rate (${fmtRate(beforeRate)} → ${fmtRate(afterRate)} per cycle), against an expected ${(expected_reduction * 100).toFixed(0)}%, so the fixed arm may keep at most ${fmtRate(v.threshold)} per cycle.`,
          '',
        );
        if (v.verdict === 'FIX_CONFIRMED') {
          lines.push(
            `✅ **FIX CONFIRMED** — the fixed arm's whole interval (${judged}) is at or under ${fmtRate(v.threshold)} per cycle.${afterRate > 0 ? ` It is not zero (${fmtRate(afterRate)}/cycle remains), so state the residual rather than claiming the leak is gone.` : ' The residual rate is zero.'}`,
          );
        } else if (v.verdict === 'FIX_FALLS_SHORT') {
          lines.push(
            `❌ **FIX FALLS SHORT** — the fixed arm's whole interval (${judged}) is above ${fmtRate(v.threshold)} per cycle: the fix removes less than the expected ${(expected_reduction * 100).toFixed(0)}%, and more rungs will not change that.`,
          );
        } else if (v.reason === 'too_few_rungs') {
          lines.push(
            `⚠ **INCONCLUSIVE** (too few rungs) — an arm has 2 rungs, and a two-point slope has no error bar, so a ${pct(reduction)} reduction cannot be told from noise. Measure 3 or more rungs per arm (the leak-hunt runner places 4 by default); the same ladders with an extra rung each are enough.`,
          );
        } else if (v.reason === 'before_not_growing') {
          lines.push(
            `⚠ **INCONCLUSIVE** (before arm not shown growing) — the before arm's interval (${fmtInterval(beforeFit)}) reaches zero, so the run has not shown the growth the fix is meant to remove. Drive more cycles or more rungs on the unfixed arm.`,
          );
        } else if (v.reason === 'run_to_run_noise') {
          lines.push(
            `⚠ **INCONCLUSIVE** (run-to-run noise as large as the effect) — two ladders of the SAME unfixed build differ by ${fmtRate(repeatSpread)} per cycle, as much as the ${fmtRate(expected_reduction * beforeRate)} per cycle the fix is expected to remove. No verdict from this setup: find what moves between runs (another session on the browser or checkout, a busy host, a different warmup) and measure again.`,
          );
        } else {
          lines.push(
            `⚠ **INCONCLUSIVE** (interval crosses the threshold) — the fixed arm's interval (${judged}) contains ${fmtRate(v.threshold)} per cycle. This run can confirm a reduction of at most ${pct(v.confirmableReduction ?? 0)} of the before arm's fitted rate. More rungs, or more cycles between rungs, narrow the interval.`,
          );
        }
        lines.push(
          '',
          `_Both arms must have been driven with the same interaction and the same ${formatNumber(cycles)} cycles between rungs; nothing in a .heapsnapshot records that, so it is the caller's to guarantee — record it with \`memlab_ladder\`. The interval assumes the rungs of one arm scatter independently around a straight line; a before arm that bends or plateaus is better read with \`memlab_rate_model\` first._`,
        );
        return toolResult(lines.join('\n'), armsHeader);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
