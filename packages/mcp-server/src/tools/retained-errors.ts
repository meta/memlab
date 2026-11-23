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
 * Retained Errors and error text, grouped by message template, across a
 * ladder.
 *
 * A retained Error is often the cheapest bug report a heap holds: something
 * threw or logged, and the app (or a logger buffer) kept it. They are small,
 * so no size-ranked analysis surfaces them; a template whose count grows per
 * cycle is an error raised per interaction.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import memlabCore from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {ladderSegments, loadRunManifest} from '../run-manifest.js';
import {
  armScanBudgetFor,
  resolveRungs,
  scaledTimeoutMs,
  withSnapshotAt,
} from '../snapshot-borrow.js';
import {
  boundedDominatorRetainedSize,
  clampLabelTo,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';
import {consoleOnlyRoots} from './console-retention.js';
import {
  collectDevRoots,
  computeReachableWithoutDevRoots,
} from './dev-artifacts.js';
import {
  frameArrayOf,
  frameClosures,
  messageOf,
  whereOf,
} from './error-callsites.js';

const {NumericSet} = memlabCore;

/** Error text kept as a string: `TypeError: …`, `Warning: …`, a stack. */
const ERROR_TEXT_RE =
  /^(?:Uncaught )?(?:[A-Z][\w$]*)?(?:Error|Exception|Warning)(?: \[[^\]]*\])?: \S/;
/** Frame names that say nothing about where an error came from. */
const GENERIC_FRAME_RE =
  /^(?:\(anonymous\)|Error|err|invariant|warning|printWarning|logError|reportError|console\.\w+|captureStack\w*)$/;

/** The first line of an error text with its variable parts replaced. */
export function errorTemplate(text: string): string {
  const line = text.split('\n')[0].trim();
  const t = line
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/(["'`])(?:(?!\1).){1,200}\1/g, '"…"')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\d+(?:\.\d+)?/g, '<n>');
  return clampLabelTo(t, 140);
}

const FRAMES_KEPT = 6;

/** The functions of the leading `at …` lines of a formatted stack. */
function stackFrames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\n\s+at (?:async )?([^\s(]+)/g)) {
    if (GENERIC_FRAME_RE.test(m[1])) continue;
    // `at https://host/path/file.js:1:2` is an anonymous function.
    const url = /^\w+:\/\/[^?#]*\/([^/?#]+?)(?:[?#][^:]*)?(:\d+:\d+)?$/.exec(
      m[1],
    );
    out.push(url != null ? `(anonymous) — ${url[1]}${url[2] ?? ''}` : m[1]);
    if (out.length === FRAMES_KEPT) break;
  }
  return out;
}

export interface ErrorTemplateGroup {
  template: string;
  example: string;
  /** Error objects. */
  objects: number[];
  /** Error text held as a string by something other than an Error. */
  strings: number[];
  /** Leading frames of the first member, from captured frames or a stack. */
  frames: string[];
  /** First frame that is not a wrapper shared by most templates. */
  frame: string | null;
}

function isErrorObject(node: IHeapNode): string | null {
  if (node.type !== 'object') return null;
  const msg = messageOf(node);
  if (msg == null) return null;
  return frameArrayOf(node) != null ? msg : null;
}

/** Every retained Error and error string, by template. */
export function collectRetainedErrors(
  snapshot: IHeapSnapshot,
): Map<string, ErrorTemplateGroup> {
  const groups = new Map<string, ErrorTemplateGroup>();
  const add = (
    text: string,
    id: number,
    kind: 'objects' | 'strings',
    frames: () => string[],
  ): void => {
    const template = errorTemplate(text);
    let g = groups.get(template);
    if (g == null) {
      g = {
        template,
        example: text,
        objects: [],
        strings: [],
        frames: [],
        frame: null,
      };
      groups.set(template, g);
    }
    g[kind].push(id);
    if (g.frames.length === 0) g.frames = frames();
  };
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (node.id <= 3) return;
    if (node.type === 'object') {
      const msg = isErrorObject(node);
      if (msg == null) return;
      const name = node.name === 'Object' ? 'Error' : node.name;
      add(`${name}: ${msg}`, node.id, 'objects', () => {
        const arr = frameArrayOf(node);
        if (arr == null || arr === 'formatted') return [];
        return frameClosures(arr)
          .filter(f => !GENERIC_FRAME_RE.test(f.name || '(anonymous)'))
          .slice(0, FRAMES_KEPT)
          .map(f => `${f.name || '(anonymous)'} — ${whereOf(snapshot, f)}`);
      });
      return;
    }
    if (!node.isString || node.name.length < 16) return;
    const text = node.toStringNode()?.stringValue ?? node.name;
    if (!ERROR_TEXT_RE.test(text)) return;
    // The `.stack` / `.message` of an Error already counted above.
    for (const e of node.referrers) {
      if (isErrorObject(e.fromNode) != null) return;
    }
    add(text, node.id, 'strings', () => stackFrames(text));
  });
  // A logging wrapper is the top frame of nearly every template, so it names
  // no call site: skip frames that lead most templates.
  const leading = new Map<string, number>();
  let framed = 0;
  for (const g of groups.values()) {
    if (g.frames.length === 0) continue;
    framed++;
    for (const f of new Set(g.frames)) {
      leading.set(f, (leading.get(f) ?? 0) + 1);
    }
  }
  for (const g of groups.values()) {
    g.frame =
      g.frames.find(f => framed < 3 || (leading.get(f) ?? 0) < 2) ??
      g.frames[0] ??
      null;
  }
  return groups;
}

export interface RetainedErrorRow {
  template: string;
  example: string;
  base: number | null;
  count: number;
  objects: number;
  strings: number;
  retained: number;
  /** Members reachable ONLY through the DevTools console, or null if none is attached. */
  consoleOnly: number | null;
  frame: string | null;
  sample: number;
}

/** Rows for `target`, against `base` counts when given. */
export function retainedErrorRows(
  target: IHeapSnapshot,
  groups: Map<string, ErrorTemplateGroup>,
  base: Map<string, number> | null,
): RetainedErrorRow[] {
  const consoleRoots = consoleOnlyRoots(collectDevRoots(target));
  const reached =
    consoleRoots.byId.size > 0
      ? computeReachableWithoutDevRoots(target, consoleRoots)
      : null;
  const rows: RetainedErrorRow[] = [];
  for (const g of groups.values()) {
    const ids = [...g.objects, ...g.strings];
    let consoleOnly: number | null = null;
    if (reached != null) {
      consoleOnly = 0;
      for (const id of ids) {
        const n = target.getNodeById(id);
        if (n != null && reached[n.nodeIndex] !== 1) consoleOnly++;
      }
    }
    rows.push({
      template: g.template,
      example: g.example,
      base: base == null ? null : (base.get(g.template) ?? 0),
      count: ids.length,
      objects: g.objects.length,
      strings: g.strings.length,
      retained: boundedDominatorRetainedSize(new NumericSet(ids), target)
        .retained,
      consoleOnly,
      frame: g.frame,
      sample: ids[ids.length - 1],
    });
  }
  return rows.sort(
    (a, b) =>
      b.count - (b.base ?? 0) - (a.count - (a.base ?? 0)) ||
      b.count - a.count ||
      a.template.localeCompare(b.template),
  );
}

function heldBy(r: RetainedErrorRow): string {
  if (r.consoleOnly == null) return 'app';
  if (r.consoleOnly === 0) return 'app';
  if (r.consoleOnly === r.count) return '**console only**';
  return `${formatNumber(r.consoleOnly)} via console`;
}

export function retainedErrorsReport(
  rows: RetainedErrorRow[],
  opts: {limit: number; cycles: number | null; baseLabel: string | null},
): string[] {
  if (rows.length === 0) {
    return ['No retained Error objects or error text in this snapshot.'];
  }
  const withBase = opts.baseLabel != null;
  const fresh = rows.filter(r => r.base === 0);
  const grew = rows.filter(r => r.base != null && r.count > r.base);
  const appGrew = grew.filter(r => r.consoleOnly !== r.count);
  const lines: string[] = [];
  if (withBase) {
    lines.push(
      `${formatNumber(rows.length)} template(s); ${formatNumber(grew.length)} grew since ${opts.baseLabel} (${formatNumber(fresh.length)} new), ` +
        `${formatNumber(appGrew.length)} of them held by the app rather than only by the DevTools console.`,
      '',
    );
  }
  const perCycle = (r: RetainedErrorRow): string =>
    opts.cycles != null && opts.cycles > 0 && r.base != null
      ? ((r.count - r.base) / opts.cycles).toFixed(2)
      : '—';
  lines.push(
    markdownTable(
      [
        'Template',
        ...(withBase ? ['Base', 'Now', 'Per cycle'] : ['Count']),
        'Retained',
        'Held by',
        'First app frame',
        'Sample',
      ],
      rows
        .slice(0, opts.limit)
        .map(r => [
          `${r.base === 0 ? '🆕 ' : ''}\`${r.template.replace(/`/g, "'")}\``,
          ...(withBase
            ? [formatNumber(r.base ?? 0), formatNumber(r.count), perCycle(r)]
            : [formatNumber(r.count)]),
          formatBytes(r.retained),
          heldBy(r),
          r.frame != null ? `\`${clampLabelTo(r.frame, 70)}\`` : '—',
          `@${r.sample}`,
        ]),
      withBase ? new Set([1, 2, 3, 4]) : new Set([1, 2]),
    ),
    '',
    '_Counts are Error objects plus error text held outside an Error (a logger buffer, a console message). "Console only" members are unreachable once DevTools console handles are cut, so they are a capture artifact; anything else is held by the app. `memlab_error_callsites({message})` gives every frame of a template, `memlab_retainer_trace` on the sample what holds it._',
  );
  return lines;
}

export function registerRetainedErrors(server: McpServer): void {
  server.tool(
    'memlab_retained_errors',
    'Retained Errors and error text (`TypeError: …`, `Warning: …`, logged stacks) grouped by message template, with the first app frame, retained size, and whether each template is held by the app or only by an attached DevTools console. With `run_dir` (first and last rung of the last isolate) or two `paths`, counts at both ends, the change per cycle, and templates new since the first rung. Errors are tiny, so no size-ranked tool shows them, yet a template that grows per cycle is an error raised per interaction: often a user-visible bug.',
    {
      run_dir: z
        .string()
        .optional()
        .describe(
          'A leak-hunt round: compare the first and last rung of its last ladder segment.',
        ),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Two snapshot files, baseline then target, instead of `run_dir`.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(12)
        .describe('Templates to list (default 12).'),
    },
    async ({run_dir, paths, limit}) => {
      try {
        let files: string[] = [];
        let cycles: number | null = null;
        if (run_dir != null && run_dir !== '') {
          const manifest = loadRunManifest(run_dir);
          const segs = ladderSegments(manifest);
          const seg = segs[segs.length - 1];
          if (seg == null || seg.paths.length === 0) {
            return errorResult(new Error(`${run_dir} has no rungs.`));
          }
          files =
            seg.paths.length > 1
              ? [seg.paths[0], seg.paths[seg.paths.length - 1]]
              : [seg.paths[0]];
          cycles = seg.paths.length > 1 ? seg.spanCycles : null;
        } else if (paths != null && paths.length > 0) {
          if (paths.length > 2) {
            return errorResult(
              new Error('`paths` takes two snapshots: baseline, then target.'),
            );
          }
          files = paths;
        }
        if (files.length === 0) {
          const snap = getSnapshot();
          const rows = retainedErrorRows(
            snap,
            collectRetainedErrors(snap),
            null,
          );
          return toolResult(
            [
              '## Retained errors',
              '',
              ...retainedErrorsReport(rows, {limit, cycles, baseLabel: null}),
            ].join('\n'),
          );
        }
        const {rungs, largestMB} = resolveRungs(files);
        let base: Map<string, number> | null = null;
        if (rungs.length === 2) {
          armScanBudgetFor(scaledTimeoutMs(largestMB));
          base = await withSnapshotAt(rungs[0].localPath, snap => {
            const counts = new Map<string, number>();
            for (const [t, g] of collectRetainedErrors(snap)) {
              counts.set(t, g.objects.length + g.strings.length);
            }
            return counts;
          });
        }
        const last = rungs[rungs.length - 1];
        armScanBudgetFor(scaledTimeoutMs(largestMB));
        const rows = await withSnapshotAt(last.localPath, snap =>
          retainedErrorRows(snap, collectRetainedErrors(snap), base),
        );
        return toolResult(
          [
            `## Retained errors — ${last.label}${base != null ? ` vs ${rungs[0].label}` : ''}`,
            '',
            ...retainedErrorsReport(rows, {
              limit,
              cycles,
              baseLabel: base != null ? rungs[0].label : null,
            }),
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
