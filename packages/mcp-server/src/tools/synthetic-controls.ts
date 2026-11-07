/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * Did a sizing round see the leak it was given, and leave the plateau alone?
 *
 * The leak-hunt runner can inject two app-independent controls (run.json
 * `synthetic_controls`): `MemlabSyntheticLeak`, a fixed number of bytes per
 * cycle that is never released, and `MemlabSyntheticPlateau`, a ring that fills
 * to a cap and then holds. A ladder that cannot see the first at its injected
 * rate is blind at that size; one that calls the second growing would call any
 * bounded cache a leak. The total-heap series then says how small a growth the
 * ladder can tell from its own noise.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import fs from 'fs';
import memlabCore from '@memlab/core';
import path from 'path';
import {z} from 'zod';
import {findResidentByPath} from '../heap-state.js';
import {loadRunManifest} from '../run-manifest.js';
import {
  armScanBudgetFor,
  resolveRungs,
  scaledTimeoutMs,
  withSnapshotAt,
} from '../snapshot-borrow.js';
import {fitSlope} from '../slope-stats.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

const {utils: memlabUtils} = memlabCore;

const LEAK_CLASS = 'MemlabSyntheticLeak';
const fmtBytes = (n: number): string => formatBytes(Math.round(n));
const PLATEAU_CLASS = 'MemlabSyntheticPlateau';

/** Instance self size plus its `payload` array and that array's elements. */
function instanceBytes(node: IHeapNode): number {
  let total = node.self_size;
  for (const e of node.references) {
    if (e.name_or_index !== 'payload') continue;
    const arr = e.toNode;
    total += arr.self_size;
    for (const inner of arr.references) {
      if (inner.name_or_index === 'elements') total += inner.toNode.self_size;
    }
    break;
  }
  return total;
}

function census(snapshot: IHeapSnapshot): {
  leakCount: number;
  leakBytes: number;
  plateauCount: number;
} {
  let leakCount = 0;
  let leakBytes = 0;
  let plateauCount = 0;
  snapshot.nodes.forEach(node => {
    if (node.type !== 'object') return;
    if (node.name === LEAK_CLASS) {
      leakCount++;
      leakBytes += instanceBytes(node);
    } else if (node.name === PLATEAU_CLASS) {
      plateauCount++;
    }
  });
  return {leakCount, leakBytes, plateauCount};
}

/**
 * A rung already loaded in the session is reused. Any other is parsed LIGHT:
 * the census reads class names, self sizes and edges, never retained sizes, so
 * the dominator pass would be paid on every rung for nothing.
 */
async function censusAt(localPath: string): Promise<ReturnType<typeof census>> {
  if (findResidentByPath(localPath) != null) {
    return withSnapshotAt(localPath, census);
  }
  return census(
    await memlabUtils.getSnapshotFromFile(localPath, {
      buildNodeIdIndex: true,
      verbose: false,
    }),
  );
}

export function registerSyntheticControls(server: McpServer): void {
  server.tool(
    'memlab_synthetic_controls',
    "Read a sizing round's SYNTHETIC CONTROLS (run.json `synthetic_controls`, from the leak-hunt runner's `--synthetic-leak-kb` / `--synthetic-plateau-cap`). " +
      'The synthetic leak (`MemlabSyntheticLeak`, a fixed number of KB per cycle, never released) is SEEN when its measured bytes per cycle are clearly above zero and within 0.5–2x the injected rate, and MISSED otherwise. The synthetic plateau (`MemlabSyntheticPlateau`, a ring of N entries) is HELD when every rung taken after the ring filled counts exactly N, and GREW otherwise. ' +
      "It also fits the round's post-GC total heap per cycle and prints the half-width of that slope's 95% interval: growth smaller than that is inside this ladder's own noise. " +
      'Works on any app, since the controls do not depend on it. Loads each rung in LIGHT mode, one at a time, and reuses a rung already loaded in the session.',
    {
      run_dir: z
        .string()
        .describe("A leak-hunt round's output directory (holds run.json)."),
    },
    async ({run_dir}) => {
      try {
        const runJson = run_dir.endsWith('.json')
          ? run_dir
          : path.join(run_dir, 'run.json');
        const raw = JSON.parse(fs.readFileSync(runJson, 'utf8')) as {
          synthetic_controls?: {
            leak_kb_per_cycle?: unknown;
            plateau_cap?: unknown;
            failed_steps?: unknown;
          } | null;
          rungs?: Array<{post_gc_heap_mb?: unknown}>;
        };
        const sc = raw.synthetic_controls;
        if (sc == null) {
          return errorResult(
            `${runJson} has no synthetic_controls: the round was not driven with --synthetic-leak-kb or --synthetic-plateau-cap.`,
          );
        }
        const leakKb =
          typeof sc.leak_kb_per_cycle === 'number' ? sc.leak_kb_per_cycle : 0;
        const cap = typeof sc.plateau_cap === 'number' ? sc.plateau_cap : 0;
        const failed =
          typeof sc.failed_steps === 'number' ? sc.failed_steps : 0;

        const manifest = loadRunManifest(runJson);
        if (manifest.paths.length < 2) {
          return errorResult(
            `the round has ${manifest.paths.length} rung(s); the controls need at least 2 (3 for the leak's interval).`,
          );
        }
        const {rungs, largestMB} = resolveRungs(manifest.paths);
        const rows: Array<{
          cycles: number;
          leakCount: number;
          leakBytes: number;
          plateauCount: number;
        }> = [];
        for (let i = 0; i < rungs.length; i++) {
          armScanBudgetFor(scaledTimeoutMs(largestMB));
          const c = await censusAt(rungs[i].localPath);
          rows.push({cycles: manifest.cyclesPerRung[i], ...c});
        }
        const xs = rows.map(r => r.cycles);

        const lines: string[] = [
          `## Synthetic controls — ${path.basename(path.dirname(runJson))}`,
          '',
          markdownTable(
            [
              'Rung',
              'Cycles',
              'Leak instances',
              'Leak bytes',
              'Plateau instances',
            ],
            rows.map((r, i) => [
              String(i),
              formatNumber(r.cycles),
              formatNumber(r.leakCount),
              fmtBytes(r.leakBytes),
              formatNumber(r.plateauCount),
            ]),
            new Set([0, 1, 2, 3, 4]),
          ),
          '',
        ];
        if (failed > 0) {
          lines.push(
            `- ${formatNumber(failed)} injection step(s) failed during the round, so fewer instances than cycles is expected.`,
            '',
          );
        }

        if (leakKb > 0) {
          const injected = leakKb * 1024;
          const fit = fitSlope(
            xs,
            rows.map(r => r.leakBytes),
          );
          const seen =
            fit.lo != null &&
            fit.lo > 0 &&
            fit.slope >= 0.5 * injected &&
            fit.slope <= 2 * injected;
          const interval =
            fit.lo == null || fit.hi == null
              ? 'no interval'
              : `${fmtBytes(Math.max(0, fit.lo))} … ${fmtBytes(fit.hi)}`;
          lines.push(
            fit.lo == null
              ? `⚠ **Synthetic leak not judged** — ${formatNumber(rows.length)} rungs give a slope with no interval (${fmtBytes(Math.max(0, fit.slope))} per cycle against ${fmtBytes(injected)} injected); 3 or more are needed.`
              : seen
                ? `✅ **Synthetic leak SEEN** — ${fmtBytes(fit.slope)} per cycle (${interval}) against ${fmtBytes(injected)} injected. A leak of this size is visible in this ladder.`
                : `❌ **Synthetic leak MISSED** — measured ${fmtBytes(Math.max(0, fit.slope))} per cycle (${interval}) against ${fmtBytes(injected)} injected. A real leak this size could go unseen here: check for reloads (the page global is cleared), failed injection steps, or too few cycles between rungs.`,
          );
        }

        if (cap > 0) {
          const filled = rows.filter(r => r.cycles >= cap);
          if (filled.length < 2) {
            lines.push(
              `⚠ **Synthetic plateau not judged** — fewer than 2 rungs were taken after the ring of ${formatNumber(cap)} filled (cycle ${formatNumber(cap)}). Drive more cycles, or use a smaller cap.`,
            );
          } else {
            const held = filled.every(r => r.plateauCount === cap);
            lines.push(
              held
                ? `✅ **Synthetic plateau HELD** — exactly ${formatNumber(cap)} instances on all ${filled.length} rungs after it filled. A bounded population is not read as growth here.`
                : `❌ **Synthetic plateau GREW** — counts after it filled: ${filled.map(r => formatNumber(r.plateauCount)).join(' → ')}, against a cap of ${formatNumber(cap)}. Something in this round retains objects the page released; treat bounded caches it flags with suspicion.`,
            );
          }
        }

        const heap = (raw.rungs ?? []).map(r =>
          typeof r.post_gc_heap_mb === 'number' ? r.post_gc_heap_mb : NaN,
        );
        if (heap.length === xs.length && heap.every(Number.isFinite)) {
          const fit = fitSlope(
            xs,
            heap.map(mb => mb * 1024 * 1024),
          );
          if (fit.lo != null && fit.hi != null) {
            lines.push(
              '',
              `- Total heap: ${fmtBytes(Math.max(0, fit.slope))} per cycle, ±${fmtBytes((fit.hi - fit.lo) / 2)}. Growth of the whole heap smaller than ${fmtBytes((fit.hi - fit.lo) / 2)} per cycle is inside this ladder's noise; a population-level probe can see less.`,
            );
          } else {
            lines.push(
              '',
              `- Total heap: no noise floor, since ${formatNumber(xs.length)} rungs give no interval.`,
            );
          }
        } else {
          lines.push(
            '',
            '- Total heap: no noise floor, since run.json does not record a post-GC heap for every rung.',
          );
        }
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
