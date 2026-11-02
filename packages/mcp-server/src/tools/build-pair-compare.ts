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
 * Which growth survives a production build?
 *
 * A dev build grows things a production build never creates: React DEV
 * fields, Fast Refresh records, compiler hook-guard chains. The decisive
 * verdicts of one sweep came from driving the same interaction on a dev build
 * and on a minified build and lining the two ladders up, which was done by
 * hand every time, because the minified build renames every class and
 * variable. Record FIELDS survive minification, so populations are matched by
 * property set (and by class only where the name is not mangled: native,
 * DOM and engine classes keep theirs).
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {resolveLadderInputs, segmentIndexArg} from '../run-manifest.js';
import {resolveRungs, withSnapshotAt} from '../snapshot-borrow.js';
import {
  ensureSidecar,
  readSidecar,
  type SnapshotIndex,
} from '../snapshot-index.js';
import {normalizeClassName} from './sequence-analysis.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

interface Side {
  label: string;
  cycles: number;
  first: SnapshotIndex;
  last: SnapshotIndex;
  combos: string[];
}

async function indexOf(localPath: string): Promise<SnapshotIndex> {
  return (
    readSidecar(localPath) ??
    (await withSnapshotAt(localPath, snap =>
      ensureSidecar(snap, localPath, normalizeClassName),
    ))
  );
}

async function loadSide(runDir: string, segment?: number): Promise<Side> {
  const inputs = resolveLadderInputs({run_dir: runDir, segment});
  const axis = inputs.cyclesPerRung;
  if (inputs.paths.length < 2 || axis == null) {
    throw new Error(
      `${runDir} needs at least two driven rungs with a cycle count each`,
    );
  }
  const cycles = axis[axis.length - 1] - axis[0];
  if (cycles <= 0) {
    throw new Error(`${runDir}: no cycles were driven between its rungs`);
  }
  const {rungs} = resolveRungs([
    inputs.paths[0],
    inputs.paths[inputs.paths.length - 1],
  ]);
  return {
    label: runDir.replace(/\/+$/, '').replace(/^.*\//, ''),
    cycles,
    first: await indexOf(rungs[0].localPath),
    last: await indexOf(rungs[1].localPath),
    combos: inputs.manifest?.combos ?? [],
  };
}

interface Rate {
  count: number;
  bytes: number;
}

function rates(
  side: Side,
  table: (i: SnapshotIndex) => Record<string, number[]>,
): Map<string, Rate> {
  const a = table(side.first);
  const b = table(side.last);
  const out = new Map<string, Rate>();
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const [c0 = 0, s0 = 0] = a[key] ?? [];
    const [c1 = 0, s1 = 0] = b[key] ?? [];
    out.set(key, {
      count: (c1 - c0) / side.cycles,
      bytes: (s1 - s0) / side.cycles,
    });
  }
  return out;
}

/**
 * Class keys whose name a minifier does not touch: anything but a 1-2
 * character JS name and plain `Object` (which shapes split better).
 */
function comparableClass(key: string): boolean {
  const [type, name = ''] = key.split('::');
  if (name === 'Object') return false;
  if (type === 'object' || type === 'closure') {
    return name.length > 2 && !/^[\w$]{1,2}$/.test(name);
  }
  return type !== 'string' && type !== 'concatenated string';
}

type Verdict = 'dev-only' | 'prod-real' | 'prod-only' | 'flat';

function verdictOf(dev: number, prod: number, minRate: number): Verdict {
  const devGrows = dev >= minRate;
  const prodGrows = prod >= minRate;
  if (devGrows && !prodGrows) return 'dev-only';
  if (devGrows && prodGrows) return 'prod-real';
  if (prodGrows) return 'prod-only';
  return 'flat';
}

function fmtRate(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}

export function registerBuildPairCompare(server: McpServer): void {
  server.tool(
    'memlab_build_pair_compare',
    'Line up a DEV-build round and a PRODUCTION-build round of the same interaction and say, per population, whether its growth is dev-only, production-real or production-only. ' +
      'Populations are matched by property set (record fields survive minification) and by class for classes a minifier does not rename (native, DOM, engine). ' +
      "Reports each side's per-cycle rate, the verdict, and the per-cycle heap growth split into the part a production build keeps and the part only a dev build has. " +
      'Reads the sidecar index of the first and last driven rung of each round, so it takes seconds when the rungs were loaded before; otherwise it loads each of the four rungs once.',
    {
      dev_run_dir: z
        .string()
        .describe('The round driven on the development build.'),
      prod_run_dir: z
        .string()
        .describe(
          'The round driven on the production (minified) build, with the same combo.',
        ),
      dev_segment: segmentIndexArg(
        'Segment of the dev round when it reloaded mid-ladder.',
      ),
      prod_segment: segmentIndexArg(
        'Segment of the production round when it reloaded mid-ladder.',
      ),
      min_rate: z
        .number()
        .min(0)
        .optional()
        .default(0.5)
        .describe(
          'Instances per cycle below which a side counts as not growing (default 0.5).',
        ),
      top: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(25)
        .describe('Rows per table (default 25).'),
    },
    async ({
      dev_run_dir,
      prod_run_dir,
      dev_segment,
      prod_segment,
      min_rate,
      top,
    }) => {
      try {
        const dev = await loadSide(dev_run_dir, dev_segment);
        const prod = await loadSide(prod_run_dir, prod_segment);
        const lines: string[] = [
          `## Build pair — dev \`${dev.label}\` (${formatNumber(dev.cycles)} cycles) vs production \`${prod.label}\` (${formatNumber(prod.cycles)} cycles)`,
          '',
        ];
        const sameCombos =
          dev.combos.length > 0 &&
          dev.combos.join(',') === prod.combos.join(',');
        if (!sameCombos) {
          lines.push(
            `> ⚠️ The rounds drove different combos (dev: ${dev.combos.join(', ') || '?'}; production: ${prod.combos.join(', ') || '?'}). A population that grows on one side only may be the combo, not the build.`,
            '',
          );
        }
        const devTotal =
          (dev.last.totalSelfSize - dev.first.totalSelfSize) / dev.cycles;
        const prodTotal =
          (prod.last.totalSelfSize - prod.first.totalSelfSize) / prod.cycles;

        const shapeTable = (i: SnapshotIndex) =>
          i.objectShapes as Record<string, number[]>;
        const classTable = (i: SnapshotIndex) => {
          const out: Record<string, number[]> = {};
          for (const [k, v] of Object.entries(i.classes)) {
            if (comparableClass(k)) out[k] = v;
          }
          return out;
        };
        const sections: Array<{
          title: string;
          keyLabel: string;
          d: Map<string, Rate>;
          p: Map<string, Rate>;
        }> = [
          {
            title: 'By property set (`Object` instances)',
            keyLabel: 'Shape',
            d: rates(dev, shapeTable),
            p: rates(prod, shapeTable),
          },
          {
            title: 'By class (names a minifier keeps)',
            keyLabel: 'Class',
            d: rates(dev, classTable),
            p: rates(prod, classTable),
          },
        ];
        let devOnlyBytes = 0;
        for (const s of sections) {
          const rows: Array<{key: string; d: Rate; p: Rate; v: Verdict}> = [];
          for (const key of new Set([...s.d.keys(), ...s.p.keys()])) {
            const d = s.d.get(key) ?? {count: 0, bytes: 0};
            const p = s.p.get(key) ?? {count: 0, bytes: 0};
            const v = verdictOf(d.count, p.count, min_rate);
            if (v === 'flat') continue;
            rows.push({key, d, p, v});
          }
          rows.sort(
            (a, b) =>
              Math.max(Math.abs(b.d.bytes), Math.abs(b.p.bytes)) -
              Math.max(Math.abs(a.d.bytes), Math.abs(a.p.bytes)),
          );
          if (s.keyLabel === 'Shape') {
            devOnlyBytes = rows
              .filter(r => r.v === 'dev-only')
              .reduce((n, r) => n + Math.max(0, r.d.bytes), 0);
          }
          const counts = {'dev-only': 0, 'prod-real': 0, 'prod-only': 0};
          for (const r of rows) counts[r.v as keyof typeof counts]++;
          lines.push(
            `### ${s.title}`,
            '',
            `${formatNumber(counts['prod-real'])} production-real · ${formatNumber(counts['dev-only'])} dev-only · ${formatNumber(counts['prod-only'])} production-only (growing at ≥ ${min_rate}/cycle on a side).`,
            '',
          );
          if (rows.length === 0) continue;
          lines.push(
            markdownTable(
              [
                s.keyLabel,
                'dev /cycle',
                'prod /cycle',
                'dev bytes/cycle',
                'prod bytes/cycle',
                'Verdict',
              ],
              rows
                .slice(0, top)
                .map(r => [
                  s.keyLabel === 'Shape'
                    ? `{${r.key.length > 60 ? `${r.key.slice(0, 59)}…` : r.key}}`
                    : r.key,
                  fmtRate(r.d.count),
                  fmtRate(r.p.count),
                  formatBytes(Math.round(r.d.bytes)),
                  formatBytes(Math.round(r.p.bytes)),
                  r.v === 'prod-real'
                    ? `prod-real (${r.d.count > 0 ? `${((r.p.count / r.d.count) * 100).toFixed(0)}% of dev` : '—'})`
                    : r.v,
                ]),
              new Set([1, 2, 3, 4]),
            ),
            '',
          );
        }
        lines.splice(
          sameCombos ? 2 : 4,
          0,
          `**Heap growth per cycle: dev ${formatBytes(Math.round(devTotal))}, production ${formatBytes(Math.round(prodTotal))}** (${formatBytes(Math.round(devTotal - prodTotal))} more on dev). ` +
            `\`Object\` shapes that grow on dev only account for ${formatBytes(Math.round(devOnlyBytes))}/cycle of it.`,
          '',
        );
        lines.push(
          "_Rates are first-to-last driven rung over the cycles between them; the settle rung is not used. Verdicts compare rates, not counts, so two rounds of different lengths line up. A dev-only row is a population the production build does not grow under the same interaction: do not file it as a leak. A production-only row usually means the combo reached something on one build only — check both rounds' step counts before reading it as a build difference._",
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
