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
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {nativePins, type NativePinGroup} from '../native-pins.js';
import {ladderSegments, loadRunManifest} from '../run-manifest.js';
import {withSnapshotAt} from '../snapshot-borrow.js';
import {
  clampLabelTo,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';
import {readArms} from './ab-compare.js';
import {resolveLadderPaths} from './ladder.js';
import {linearFit} from './ladder-probe.js';

const NOTE =
  '_Each native (browser) node is charged to its nearest JavaScript dominator: cutting that object frees it. A promise is named by its first `.then` handler, a closure by its function. A JS heap total does not include these bytes, so a leak made of them shows here and not in `app_delta`._';

function classesCell(g: NativePinGroup): string {
  return g.classes
    .slice(0, 3)
    .map(([c, b]) => `${clampLabelTo(c, 40)} ${formatBytes(b)}`)
    .join(', ');
}

async function ladderLines(
  paths: string[],
  axisIn: number[] | null,
  limit: number,
  title: string,
): Promise<string[]> {
  // A rung that fails to load reads `—`; the rest are still measured.
  const perRung: Array<Map<string, NativePinGroup> | null> = [];
  const totals: Array<number | null> = [];
  const failed: string[] = [];
  for (const p of paths) {
    try {
      const r = await withSnapshotAt(p, snap => nativePins(snap));
      perRung.push(new Map(r.groups.map(g => [g.label, g])));
      totals.push(r.total);
    } catch (err) {
      perRung.push(null);
      totals.push(null);
      failed.push(
        `${p.replace(/^.*\//, '')}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const axis = axisIn != null && axisIn.length === paths.length ? axisIn : null;
  const xs = axis ?? paths.map((_, i) => i);
  const unit = axis != null ? 'cycle' : 'rung';
  const slopeOf = (ys: Array<number | null>): string => {
    const pts = ys
      .map((y, i) => ({x: xs[i], y}))
      .filter((pt): pt is {x: number; y: number} => pt.y != null);
    if (pts.length < 2) return '—';
    const {slope} = linearFit(
      pts.map(pt => pt.x),
      pts.map(pt => pt.y),
    );
    return `${slope >= 0 ? '+' : ''}${slope.toFixed(2)}`;
  };
  const failedLines =
    failed.length > 0
      ? [
          '',
          `${failed.length} rung(s) failed to load:`,
          ...failed.map(f => `- ${f}`),
        ]
      : [];
  const last = [...perRung].reverse().find(m => m != null);
  if (last == null) return [title, '', 'No rung loaded.', ...failedLines];
  const labels = [...last.values()]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit)
    .map(g => g.label);
  const kb = (b: number) => Math.round(b / 1024);
  const rows = labels.map(label => {
    const series = perRung.map(m =>
      m == null ? null : kb(m.get(label)?.bytes ?? 0),
    );
    const g = last.get(label) as NativePinGroup;
    return [
      clampLabelTo(label, 90),
      ...series.map(v => (v == null ? '—' : formatNumber(v))),
      slopeOf(series),
      formatNumber(g.pinners),
      classesCell(g),
      `@${g.sample}`,
    ];
  });
  const totalsKb = totals.map(t => (t == null ? null : kb(t)));
  return [
    title,
    '',
    `Native KB pinned by JS per rung: ${totalsKb.map(t => (t == null ? '—' : formatNumber(t))).join(' → ')} (${slopeOf(totalsKb)} KB/${unit}).`,
    '',
    markdownTable(
      [
        'Pinned by',
        ...paths.map((p, i) =>
          axis != null ? `c${xs[i]} KB` : `${p.replace(/^.*\//, '')} KB`,
        ),
        `Δ KB/${unit}`,
        'Pinners',
        'Top native classes (last rung)',
        'Sample',
      ],
      rows,
      new Set(
        paths.map((_, i) => i + 1).concat([paths.length + 1, paths.length + 2]),
      ),
    ),
    ...failedLines,
  ];
}

export function registerNativePinCost(server: McpServer): void {
  server.tool(
    'memlab_native_pin_cost',
    'Native (browser) memory that JavaScript alone keeps alive, grouped by the JS object that pins it: a promise by its first `.then` handler, a closure by its function, anything else by class. Each native node is charged to its nearest JS dominator, so the bytes are what cutting that object frees. A never-settling promise can pin hundreds of KB of Blink objects through its reactions while its JS side is two small objects, so neither `app_delta` nor a heap-total rate moves. With `run_dir` or `paths`, KB per group at every rung and per cycle; a run split by a reload (an A/B round) is read per arm.',
    {
      run_dir: z
        .string()
        .optional()
        .describe('A leak-hunt round: measure every rung of its ladder.'),
      paths: z
        .array(z.string())
        .optional()
        .describe('Ordered snapshot paths instead of run_dir.'),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(12)
        .describe('Groups to list (default 12).'),
    },
    async ({run_dir, paths, limit}) => {
      try {
        if (run_dir == null && (paths == null || paths.length === 0)) {
          const r = nativePins(getSnapshot());
          return toolResult(
            [
              '## Native memory pinned by JavaScript',
              '',
              `${formatBytes(r.total)} of native memory has a JS dominator; ${formatBytes(r.unpinned)} more is held by the browser alone.`,
              '',
              markdownTable(
                [
                  'Pinned by',
                  'Native',
                  'Nodes',
                  'Pinners',
                  'Top native classes',
                  'Sample',
                ],
                r.groups
                  .slice(0, limit)
                  .map(g => [
                    clampLabelTo(g.label, 90),
                    formatBytes(g.bytes),
                    formatNumber(g.natives),
                    formatNumber(g.pinners),
                    classesCell(g),
                    `@${g.sample}`,
                  ]),
                new Set([1, 2, 3]),
              ),
              '',
              NOTE,
            ].join('\n'),
          );
        }
        if (run_dir != null) {
          const manifest = loadRunManifest(run_dir);
          const segs = ladderSegments(manifest);
          if (segs.length > 1) {
            let arms: Array<{name: string; paths: string[]}> = [];
            try {
              arms = readArms(run_dir);
            } catch {
              arms = [];
            }
            const out = [
              `## Native memory pinned by JavaScript: ${segs.length} isolate segments`,
              '',
              '_The page reloaded mid-run, so each segment is a different V8 isolate and is read on its own._',
            ];
            // By file name: run.json may record a rung relative to the round
            // while the manifest resolves it.
            const base = (p: string) => p.replace(/^.*\//, '');
            for (const seg of segs) {
              const arm = arms.find(a =>
                a.paths.some(p => base(p) === base(seg.paths[0])),
              );
              out.push(
                '',
                ...(await ladderLines(
                  seg.paths,
                  seg.cyclesPerRung,
                  limit,
                  `### Segment ${seg.index}${arm != null ? ` (${arm.name.toUpperCase()} arm)` : ''}: rungs ${seg.firstRung}-${seg.lastRung}`,
                )),
              );
            }
            out.push('', NOTE);
            return toolResult(out.join('\n'));
          }
          return toolResult(
            [
              ...(await ladderLines(
                manifest.paths,
                manifest.cyclesPerRung,
                limit,
                `## Native memory pinned by JavaScript across ${manifest.paths.length} rungs`,
              )),
              '',
              NOTE,
            ].join('\n'),
          );
        }
        const files = resolveLadderPaths(paths as string[]).paths;
        return toolResult(
          [
            ...(await ladderLines(
              files,
              null,
              limit,
              `## Native memory pinned by JavaScript across ${files.length} snapshots`,
            )),
            '',
            NOTE,
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
