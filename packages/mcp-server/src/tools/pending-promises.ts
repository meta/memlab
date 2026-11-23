/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode} from '@memlab/core';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {withSnapshotAt} from '../snapshot-borrow.js';
import {loadRunManifest} from '../run-manifest.js';
import {
  isPendingPromise,
  pendingPromises,
  promiseReactions,
  reactionHandlers,
  reactionNativeCost,
} from '../promise-chains.js';
import {ladderSegments} from '../run-manifest.js';
import {readArms} from './ab-compare.js';
import {whereOf} from './error-callsites.js';
import type {IHeapSnapshot} from '@memlab/core';
import {resolveLadderPaths} from './ladder.js';
import {linearFit} from './ladder-probe.js';
import {ownerLabel} from './async-census.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * The unsettled promises with the longest reaction chains, tracked by node id
 * across a ladder. Heap-snapshot ids are stable for one object within one V8
 * isolate, so the same promise can be read at every rung and its chain fitted
 * per cycle — the signature of a promise that never settles while every
 * interaction attaches another `.then`.
 */
function nativeCell(c: ReturnType<typeof reactionNativeCost>): string {
  if (c.attributions === 0) return '—';
  return (
    `${formatBytes(c.bytes)} (${formatNumber(c.attributions)} task-attribution` +
    (c.softNavContexts > 0
      ? `, ${formatNumber(c.softNavContexts)} soft-nav context(s)`
      : '') +
    ')'
  );
}

const NATIVE_NOTE =
  '_Native via reactions: Blink objects each `.then` keeps alive through its task-attribution record (`PromiseReaction → CppHeapExternal → blink::TaskAttributionInfoImpl → SoftNavigationContext`). They are on no JS retainer path, so a never-settling promise costs this much more per reaction. A `Promise.all` attaches one reaction to each input, so promises it spans can share these objects: do not sum the column. Check whether the promise ever settles in production before calling it a leak._';

/** The first `.then` handler of a promise: function and where it lives. */
function creatorOf(snapshot: IHeapSnapshot, promise: IHeapNode): string {
  const [fn] = reactionHandlers(promise, 1);
  if (fn == null) return '—';
  return `${fn.name || '(anonymous)'} — ${whereOf(snapshot, fn)}`;
}

/** Pending promises per rung that `creator` mode labels, longest first. */
const CREATOR_POOL = 2000;

/**
 * Reactions per first-handler creator at every rung. A label, unlike a node
 * id, means the same thing in every rung and every isolate.
 */
async function creatorLadder(
  rungPaths: string[],
  axisIn: number[] | null,
  top: number,
  title: string,
): Promise<string[]> {
  if (rungPaths.length < 2) return [title, '', 'Need at least two rungs.'];
  const perRung: Array<Map<string, {promises: number; reactions: number}>> = [];
  for (const p of rungPaths) {
    perRung.push(
      await withSnapshotAt(p, snap => {
        const m = new Map<string, {promises: number; reactions: number}>();
        for (const {node, reactions} of pendingPromises(snap).slice(
          0,
          CREATOR_POOL,
        )) {
          const c = creatorOf(snap, node);
          const row = m.get(c) ?? {promises: 0, reactions: 0};
          row.promises++;
          row.reactions += reactions;
          m.set(c, row);
        }
        return m;
      }),
    );
  }
  const axis =
    axisIn != null && axisIn.length === rungPaths.length ? axisIn : null;
  const xs = axis ?? rungPaths.map((_, i) => i);
  const unit = axis != null ? 'cycle' : 'rung';
  const last = perRung[perRung.length - 1];
  const creators = [...last.entries()]
    .sort((a, b) => b[1].reactions - a[1].reactions)
    .slice(0, top)
    .map(([c]) => c);
  let growing = 0;
  const rows = creators.map(c => {
    const series = perRung.map(m => m.get(c)?.reactions ?? 0);
    const slope = linearFit(xs, series).slope;
    if (slope > 0) growing++;
    return [
      c,
      ...series.map(formatNumber),
      `${slope >= 0 ? '+' : ''}${slope.toFixed(3)}`,
      formatNumber(last.get(c)?.promises ?? 0),
    ];
  });
  return [
    title,
    '',
    markdownTable(
      [
        'First handler (creator)',
        ...rungPaths.map((p, i) =>
          axis != null ? `c${xs[i]}` : p.replace(/^.*\//, ''),
        ),
        `Δ reactions/${unit}`,
        'Promises (last rung)',
      ],
      rows,
      new Set(
        rungPaths
          .map((_, i) => i + 1)
          .concat([rungPaths.length + 1, rungPaths.length + 2]),
      ),
    ),
    '',
    growing > 0
      ? `**${growing} creator(s) gain reactions every ${unit}.** Each row sums every pending promise whose first \`.then\` handler is that function; a never-settling promise that each interaction attaches to grows like this.`
      : '_No creator gains reactions across the ladder._',
  ];
}

/** How many of a rung's longest chains an owner-path match looks through. */
const OWNER_MATCH_POOL = 200;

/** A rung's cell where two promises share the tracked one's owner path. */
const AMBIGUOUS = 'ambiguous';

/** An owner label specific enough to identify one promise across rungs. */
function matchableOwner(owner: string): boolean {
  return owner !== '(no retainer path)' && owner !== '(root)';
}

export function registerPendingPromises(server: McpServer): void {
  server.tool(
    'memlab_pending_promises',
    'Unsettled Promises ranked by REACTION-CHAIN length, with retained size, the native (Blink task-attribution / soft-navigation) memory their reactions keep alive, and the production owner path. One promise that never settles keeps every `.then` callback attached to it, so the leak is a long chain on ONE promise — invisible to a count of unsettled promises. ' +
      'With `run_dir` (or `paths`) it takes the top promises on the last rung and reads each one at every rung, by node id or else by owner path: "+N reactions/cycle on one promise" is a promise that never settles while every interaction attaches to it. Without either it ranks the loaded snapshot.',
    {
      run_dir: z
        .string()
        .optional()
        .describe(
          'A leak-hunt run directory: track the top promises across its rungs.',
        ),
      paths: z
        .array(z.string())
        .optional()
        .describe('Ordered snapshot paths, oldest first, instead of run_dir.'),
      top: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(10)
        .describe('How many promises to report (default 10).'),
      group_by: z
        .enum(['promise', 'creator'])
        .optional()
        .default('promise')
        .describe(
          'With `run_dir` / `paths`: "promise" (default) tracks the top promises by id or owner path; "creator" sums every pending promise\'s reactions per first `.then` handler (function and module), which is stable across rungs and isolates.',
        ),
    },
    async ({run_dir, paths, top, group_by}) => {
      try {
        if (run_dir == null && (paths == null || paths.length === 0)) {
          const snapshot = getSnapshot();
          const all = pendingPromises(snapshot);
          const rows = all
            .slice(0, top)
            .map(({node, reactions}) => [
              `@${node.id}`,
              formatNumber(reactions),
              formatBytes(node.retainedSize),
              nativeCell(reactionNativeCost(node)),
              ownerLabel(snapshot, node),
            ]);
          return toolResult(
            [
              `## Unsettled promises — ${formatNumber(all.length)} pending`,
              '',
              markdownTable(
                [
                  'Promise',
                  'Reactions',
                  'Retained',
                  'Native via reactions',
                  'Owner (production path tail)',
                ],
                rows,
                new Set([1, 2]),
              ),
              '',
              NATIVE_NOTE,
              '',
              '_Pass `run_dir` to see whether a chain grows per cycle._',
            ].join('\n'),
          );
        }

        let rungPaths: string[];
        let axis: number[] | null = null;
        let segments: Array<{
          paths: string[];
          axis: number[];
          title: string;
        }> | null = null;
        if (run_dir != null) {
          const manifest = loadRunManifest(run_dir);
          rungPaths = manifest.paths;
          axis = manifest.cyclesPerRung;
          const segs = ladderSegments(manifest);
          // A reload splits the run into isolates (an A/B round's arms): each
          // is tracked on its own, over its own cycles.
          if (segs.length > 1) {
            let arms: Array<{name: string; paths: string[]}> = [];
            try {
              arms = readArms(run_dir);
            } catch {
              arms = [];
            }
            segments = segs.map(seg => {
              const arm = arms.find(a => a.paths.includes(seg.paths[0]));
              return {
                paths: seg.paths,
                axis: seg.cyclesPerRung,
                title: `### Segment ${seg.index}${arm != null ? ` (${arm.name.toUpperCase()} arm)` : ''}: rungs ${seg.firstRung}-${seg.lastRung}`,
              };
            });
          }
        } else {
          rungPaths = resolveLadderPaths(paths as string[]).paths;
        }
        const run = group_by === 'creator' ? creatorLadder : promiseLadder;
        if (segments != null) {
          const out: string[] = [
            `## Unsettled promises: ${segments.length} isolate segments`,
            '',
            '_The page reloaded mid-run, so each segment is a different V8 isolate and is read on its own._',
          ];
          for (const seg of segments) {
            out.push('', ...(await run(seg.paths, seg.axis, top, seg.title)));
          }
          return toolResult(out.join('\n'));
        }
        return toolResult(
          (
            await run(
              rungPaths,
              axis,
              top,
              `## Unsettled promises across ${rungPaths.length} rungs`,
            )
          ).join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

async function promiseLadder(
  rungPaths: string[],
  axisIn: number[] | null,
  top: number,
  title: string,
): Promise<string[]> {
  let axis = axisIn;
  if (rungPaths.length < 2) {
    return [title, '', 'Need at least two rungs.'];
  }
  type Chain = {count: number; capped: boolean; byOwner?: boolean};
  type Cell = Chain | null | typeof AMBIGUOUS;
  const chainOf = (node: IHeapNode): Chain => {
    const {count, truncated} = promiseReactions(node);
    return {count, capped: truncated};
  };
  // The last rung picks the promises to track, and the same load gives
  // its own column and pending total.
  const last = rungPaths[rungPaths.length - 1];
  const {tracked, lastCounts, lastTotal} = await withSnapshotAt(last, snap => {
    const pending = pendingPromises(snap);
    const head = pending.slice(0, top);
    return {
      tracked: head.map(({node}) => ({
        id: node.id,
        owner: ownerLabel(snap, node),
        creator: creatorOf(snap, node),
        retained: node.retainedSize,
        native: nativeCell(reactionNativeCost(node)),
      })),
      lastCounts: head.map(({node}) => chainOf(node)),
      lastTotal: pending.length,
    };
  });
  if (tracked.length === 0) {
    return [title, '', 'No unsettled promise on the last rung.'];
  }
  // An owner path shared by two tracked promises cannot tell them apart.
  const trackedPerOwner = new Map<string, number>();
  for (const t of tracked) {
    trackedPerOwner.set(t.owner, (trackedPerOwner.get(t.owner) ?? 0) + 1);
  }
  const perRung: Array<Array<Cell>> = [];
  const pendingTotals: number[] = [];
  for (const p of rungPaths.slice(0, -1)) {
    const {counts, total} = await withSnapshotAt(p, snap => {
      // By id first: no walk. A promise that exists but has settled
      // reads 0, not "absent".
      const out: Array<Cell> = tracked.map(t => {
        const node = snap.getNodeById(t.id);
        return node != null && node.type === 'object' && node.name === 'Promise'
          ? chainOf(node)
          : null;
      });
      // Ids are not stable across rungs, so a promise the id misses is
      // looked for by its owner path among this rung's longest chains.
      // Without this, a promise that grew all ladder long read absent
      // on every rung but the last.
      // A match needs the owner path to name one promise on both sides:
      // with two candidates either could be the tracked one, and the
      // cell reads `?` rather than another promise's chain.
      if (out.some(c => c == null)) {
        const byId = new Set(
          tracked.filter((_, i) => out[i] != null).map(t => t.id),
        );
        const byOwner = new Map<string, IHeapNode[]>();
        for (const {node} of pendingPromises(snap).slice(0, OWNER_MATCH_POOL)) {
          if (byId.has(node.id)) continue;
          const owner = ownerLabel(snap, node);
          const nodes = byOwner.get(owner);
          if (nodes == null) byOwner.set(owner, [node]);
          else nodes.push(node);
        }
        tracked.forEach((t, i) => {
          if (out[i] != null || !matchableOwner(t.owner)) return;
          const nodes = byOwner.get(t.owner);
          if (nodes == null) return;
          if (nodes.length > 1 || (trackedPerOwner.get(t.owner) ?? 0) > 1) {
            out[i] = AMBIGUOUS;
            return;
          }
          out[i] = {...chainOf(nodes[0]), byOwner: true};
        });
      }
      let n = 0;
      snap.nodes.forEach(node => {
        if (isPendingPromise(node)) n++;
      });
      return {counts: out, total: n};
    });
    perRung.push(counts);
    pendingTotals.push(total);
  }
  perRung.push(lastCounts);
  pendingTotals.push(lastTotal);
  // An axis that does not match the rungs is dropped, so the rate is
  // labeled per rung rather than mislabeled per cycle.
  if (axis != null && axis.length !== rungPaths.length) axis = null;
  const xs = axis ?? rungPaths.map((_, i) => i);
  const unit = axis != null ? 'cycle' : 'rung';
  // Raw slopes, so the "growing" count does not re-read a rounded cell.
  const slopes: Array<number | null> = [];
  let atCap = 0;
  const rows = tracked.map((t, ti) => {
    const cells = perRung.map(r => r[ti]);
    const chains = cells.map(c => (c === AMBIGUOUS ? null : c));
    const series = chains.map(c => c?.count ?? null);
    // A chain at the walk cap is at least that long, so its flat
    // series says nothing about growth.
    const capped = chains.some(c => c?.capped === true);
    const present = series
      .map((v, i) => ({v, x: xs[i]}))
      .filter((p): p is {v: number; x: number} => p.v != null);
    const slope =
      present.length >= 2 && new Set(present.map(p => p.x)).size >= 2
        ? linearFit(
            present.map(p => p.x),
            present.map(p => p.v),
          ).slope
        : null;
    // Its growth is unknown, so it is reported apart from the growers.
    if (capped) atCap++;
    slopes.push(capped ? null : slope);
    return [
      `@${t.id}`,
      ...cells.map(c =>
        c == null
          ? '—'
          : c === AMBIGUOUS
            ? '?'
            : `${c.capped ? '≥' : ''}${formatNumber(c.count)}${c.byOwner === true ? '*' : ''}`,
      ),
      capped
        ? '? (at cap)'
        : slope == null
          ? '—'
          : `${slope >= 0 ? '+' : ''}${slope.toFixed(3)}`,
      formatBytes(t.retained),
      t.native,
      t.creator,
      t.owner,
    ];
  });
  const growing = slopes.filter(s => s != null && s > 0).length;
  return [
    title,
    '',
    `Pending promises per rung: ${pendingTotals.map(formatNumber).join(' → ')}.`,
    '',
    markdownTable(
      [
        'Promise',
        ...rungPaths.map((p, i) =>
          axis != null ? `c${xs[i]}` : p.replace(/^.*\//, ''),
        ),
        `Δ reactions/${unit}`,
        'Retained',
        'Native via reactions (last rung)',
        'First handler',
        'Owner (production path tail)',
      ],
      rows,
    ),
    '',
    growing > 0
      ? `**${growing} promise(s) gain reactions every ${unit}.** A promise that never settles while each interaction attaches a \`.then\` grows exactly like this; find what should resolve or reject it (a load that can fail without rejecting, a missing timeout).`
      : '_No tracked promise gains reactions across the ladder._',
    ...(atCap > 0
      ? [
          '',
          `**${atCap} promise(s) hold a chain at the walk cap** — at least that many reactions on one promise, growth unknown. Treat each as a leak until \`helpers.promiseReactions(id)\` says otherwise.`,
        ]
      : []),
    '',
    NATIVE_NOTE,
    '',
    '_`—` = no promise with that id or owner path at that rung (created later, or settled and collected). `N*` = matched by owner path, because node ids change between rungs. `?` = more than one promise has that owner path at that rung, so none is matched. `≥N` = the chain walk stopped at its cap._',
  ];
}
