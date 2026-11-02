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
 * Who holds the NEWEST instances of a population?
 *
 * V8 assigns heap-snapshot node ids monotonically as objects are allocated, so
 * the highest-id members of a class ARE its most recently created ones — the
 * cohort a ladder's growth is made of. `memlab_leak_report` already uses that
 * to pick the retainer it votes on, and the underlying primitive was
 * hand-written twice in one sweep:
 *
 *     const ids = helpers.byClass('Object', {type:'object'}).sort((a,b)=>a-b);
 *     const newest = ids.slice(-6000);
 *     // group by first referrer edge name + by shape
 *
 * The answer that matters is usually the DISAGREEMENT: the newest instances
 * held by one thing and the population at large by another is the signature of
 * a static collection sitting next to an accumulating one, and only the second
 * grew. So both are reported side by side.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import memlabCore from '@memlab/core';
const {utils, NumericSet} = memlabCore;
import {z} from 'zod';
import {getFilePath, getSnapshot} from '../heap-state.js';
import {noteSnapshotRead} from '../read-scope.js';
import {resolveRungs, withSnapshotAt} from '../snapshot-borrow.js';
import {
  clampLabel,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * `<holder class> (<type>) .<edge>`, with array indices collapsed.
 *
 * A numeric index is per-instance, so leaving it in turns one accumulating
 * array into N rows of count 1 and the histogram reports nothing. Measured:
 * `(object elements) (array) .400 … .404`, five rows at 1% each, for a
 * population entirely held by one array.
 */
function edgeName(raw: string): string {
  return /^\d+$/.test(raw) ? '[i]' : clampLabel(raw, 40);
}

/** `<holder class> (<type>) .<edge>` for the edge that points AT this node. */
function referrerEdgeLabel(node: IHeapNode): string {
  let best: string | null = null;
  try {
    for (const e of node.referrers) {
      const from = e.fromNode;
      const name = edgeName(String(e.name_or_index));
      const label = `${clampLabel(from.name.length > 0 ? from.name : '(anonymous)', 60)} (${from.type}) .${name}`;
      // Prefer a NAMED edge from a non-synthetic holder: `(GC roots)` and
      // `system /` containers are true of almost everything and name nothing.
      if (
        from.type !== 'synthetic' &&
        !from.name.startsWith('system / ') &&
        e.type !== 'hidden'
      ) {
        return label;
      }
      best = best ?? label;
    }
  } catch {
    // An unreadable edge list is not a reason to lose the node.
  }
  return best ?? '(no referrer)';
}

function shapeLabel(node: IHeapNode): string {
  const names: string[] = [];
  try {
    for (const e of node.references) {
      if (e.type !== 'property') continue;
      const n = String(e.name_or_index);
      if (n === '__proto__') continue;
      names.push(n);
    }
  } catch {
    return '(unreadable)';
  }
  if (names.length === 0) return '(no properties)';
  names.sort();
  return clampLabel(`{${names.join(',')}}`, 60);
}

/** The first `k` sorted property names, `…` marking the ones left out. */
function shapePrefixLabel(node: IHeapNode, k: number): string {
  const names: string[] = [];
  try {
    for (const e of node.references) {
      if (e.type !== 'property') continue;
      const n = String(e.name_or_index);
      if (n !== '__proto__') names.push(n);
    }
  } catch {
    return '(unreadable)';
  }
  if (names.length === 0) return '(no properties)';
  names.sort();
  const shown = names.slice(0, k).map(n => clampLabel(n, 24));
  return `{${shown.join(',')}${names.length > k ? ',…' : ''}}`;
}

/** The selector both rungs are filtered with, so their groups compare. */
interface Selector {
  className?: string;
  want: Set<string> | null;
  nodeType?: string;
}

function selectNodes(snapshot: IHeapSnapshot, sel: Selector): IHeapNode[] {
  const out: IHeapNode[] = [];
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (node.id <= 3) return;
    if (sel.nodeType != null && node.type !== sel.nodeType) return;
    if (
      sel.className != null &&
      sel.className !== '' &&
      node.name !== sel.className
    ) {
      return;
    }
    if (sel.want != null) {
      // DISTINCT names. Counting matching edges instead lets one wanted key
      // present on several edges — which a heap does produce — satisfy a
      // two-key shape on its own, so `[a, b]` matches an object that has
      // only `a`.
      const seen = new Set<string>();
      try {
        for (const e of node.references) {
          if (e.type !== 'property') continue;
          const n = String(e.name_or_index);
          if (sel.want.has(n)) seen.add(n);
        }
      } catch {
        return;
      }
      if (seen.size < sel.want.size) return;
    }
    out.push(node);
  });
  return out;
}

/** The class of the GC-root-side end of this node's retainer path. */
function rootPathHead(node: IHeapNode): string {
  let cur: IHeapNode | null = node;
  const seen = new Set<number>([node.id]);
  let last = node;
  let hops = 0;
  while (cur != null && cur.hasPathEdge && hops++ < 64) {
    const edge = cur.pathEdge;
    if (edge == null) break;
    const from: IHeapNode = edge.fromNode;
    if (seen.has(from.id)) break;
    seen.add(from.id);
    last = from;
    cur = from;
  }
  return clampLabel(last.name.length > 0 ? last.name : `(${last.type})`, 60);
}

function histogram(
  nodes: readonly IHeapNode[],
  keyFn: (n: IHeapNode) => string,
  top: number,
): Array<{key: string; count: number}> {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const k = keyFn(n);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({key, count}))
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
}

function share(count: number, of: number): string {
  return of > 0 ? `${((count / of) * 100).toFixed(0)}%` : '—';
}

function combinedRetained(
  nodes: readonly IHeapNode[],
  snapshot: IHeapSnapshot,
): number {
  return utils.aggregateDominatorMetrics(
    new NumericSet(nodes.map(n => n.id)),
    snapshot,
    () => true,
    (node: IHeapNode) => node.retainedSize,
  );
}

/**
 * The cohort grouped by (referrer edge, shape prefix) in one table.
 *
 * The separate tables say "60% are held by `Map.table`" and "40% are
 * `{action,eagerState,…}`" without saying whether those are the same 40%.
 * On a class like `Object`, where the growth is several record types under
 * different holders, the joint key is what splits it into rows a fix can act
 * on.
 */
async function jointTable(opts: {
  snapshot: IHeapSnapshot;
  all: readonly IHeapNode[];
  newest: readonly IHeapNode[];
  selector: Selector;
  shapeKeys: number;
  top: number;
  baselinePath?: string;
}): Promise<string[]> {
  const keyOf = (n: IHeapNode): string =>
    `${referrerEdgeLabel(n)} · ${shapePrefixLabel(n, opts.shapeKeys)}`;
  const groups = new Map<string, IHeapNode[]>();
  for (const n of opts.newest) {
    const k = keyOf(n);
    const g = groups.get(k);
    if (g) g.push(n);
    else groups.set(k, [n]);
  }
  const ranked = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, opts.top);
  const wanted = new Set(ranked.map(([k]) => k));
  const countIn = (nodes: readonly IHeapNode[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const n of nodes) {
      const k = keyOf(n);
      if (wanted.has(k)) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const totalNow = countIn(opts.all);
  let baseline: Map<string, number> | null = null;
  let baselineLabel = '';
  if (opts.baselinePath != null && opts.baselinePath !== '') {
    // The header lists the files read; without this it names only the
    // baseline, as if the table were about it.
    const active = getFilePath();
    if (active != null) noteSnapshotRead(active);
    const {rungs} = resolveRungs([opts.baselinePath]);
    baselineLabel = rungs[0].label.replace(/^.*\//, '');
    baseline = await withSnapshotAt(rungs[0].localPath, snap =>
      countIn(selectNodes(snap, opts.selector)),
    );
  }
  const rows = ranked.map(([key, nodes]) => {
    const [holder, shapeText] = key.split(' · ');
    const now = totalNow.get(key) ?? 0;
    return [
      holder,
      shapeText,
      formatNumber(nodes.length),
      share(nodes.length, opts.newest.length),
      formatNumber(now),
      ...(baseline != null
        ? [
            formatNumber(baseline.get(key) ?? 0),
            `${now - (baseline.get(key) ?? 0) >= 0 ? '+' : ''}${formatNumber(now - (baseline.get(key) ?? 0))}`,
          ]
        : []),
      formatBytes(nodes.reduce((s, n) => s + n.self_size, 0)),
      formatBytes(combinedRetained(nodes, opts.snapshot)),
      `@${nodes[nodes.length - 1].id}`,
    ];
  });
  return [
    '### Newest instances by (referrer edge, shape)',
    '',
    `_Shape = the first ${opts.shapeKeys} sorted property names. "now" counts the whole population with that key on this rung, not just the cohort${baseline != null ? `; "baseline" counts it on \`${baselineLabel}\`` : ''}._`,
    '',
    markdownTable(
      [
        'Referrer edge',
        'Shape',
        'newest',
        'share',
        'now',
        ...(baseline != null ? ['baseline', 'Δ'] : []),
        'Σ self',
        'retained',
        'example',
      ],
      rows,
      new Set(baseline != null ? [2, 3, 4, 5, 6, 7, 8] : [2, 3, 4, 5, 6]),
    ),
    '',
  ];
}

export function registerGrowthCohort(server: McpServer): void {
  server.tool(
    'memlab_growth_cohort',
    'Group the NEWEST instances of a population by who holds them — top referrer edges, top shapes, top root-path heads, and their dominator-deduped retained size.\n\n' +
      'V8 assigns heap-snapshot node ids monotonically as objects are allocated, so the highest-id members of a class ARE the ones created most recently: the tail IS the growth cohort. That is the population a ladder measured growing, and it is usually not the population a whole-class question answers about.\n\n' +
      'The point is the DISAGREEMENT. This reports the cohort next to the whole population, so "the newest instances are held by `X` while the class at large is held by `Y`" is visible in one call — the signature of a large static collection sitting beside a small accumulating one, where only the second grew. A retainer voted over the whole population names the static one every time.\n\n' +
      'Select with `class_name`, `shape` (a property set), or both. Needs a snapshot loaded, ideally the LAST rung of a ladder. `group_by: "referrer+shape"` groups the cohort by (referrer edge, shape) in one table, and `baseline_path` adds each group\'s count on an earlier rung.',
    {
      class_name: z
        .string()
        .optional()
        .describe(
          'Constructor name to select, e.g. "Object" or "HTMLDivElement". Combine with `shape` when the class is generic.',
        ),
      shape: z
        .array(z.string())
        .optional()
        .describe(
          'Property names every selected object must carry, e.g. ["event","timestamp"]. Use when the class name is `Object` and says nothing.',
        ),
      node_type: z
        .string()
        .optional()
        .describe(
          'Restrict to one heap node type ("object", "closure", "string", "array", …). Defaults to every type, matching memlab_find_nodes_by_class.',
        ),
      cohort: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(5000)
        .describe(
          'How many of the highest-id (newest) instances to group (default 5000). Set it near the growth the ladder measured: a cohort much larger than the growth mixes in the standing population and the disagreement disappears.',
        ),
      top: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(12)
        .describe('Rows per breakdown table (default 12).'),
      group_by: z
        .enum(['separate', 'referrer+shape'])
        .optional()
        .default('separate')
        .describe(
          '"separate" (default): one table each for referrer edges, shapes and root-path heads. "referrer+shape": ONE table keyed by (referrer edge, first `shape_keys` property names), with count, self size and dominator-deduped retained size per group. Use it on a class like `Object`, where the growth is several record types held by different things and the two separate tables cannot say which shape goes with which holder.',
        ),
      shape_keys: z
        .number()
        .int()
        .min(1)
        .max(24)
        .optional()
        .default(5)
        .describe(
          'With `group_by: "referrer+shape"`: how many sorted property names form the shape part of the key (default 5).',
        ),
      baseline_path: z
        .string()
        .optional()
        .describe(
          'With `group_by: "referrer+shape"`: an earlier rung of the SAME ladder. Its whole population is grouped by the same key, and each row gets the baseline count and the growth since it, so a group that was already there at baseline is not read as new.',
        ),
    },
    async ({
      class_name,
      shape,
      node_type,
      cohort,
      top,
      group_by,
      shape_keys,
      baseline_path,
    }) => {
      try {
        if (
          (class_name == null || class_name === '') &&
          (shape == null || shape.length === 0)
        ) {
          return errorResult(
            new Error(
              'Pass `class_name`, `shape`, or both. Without a selector this would group every node in the heap, which is a class histogram and already exists as `memlab_class_histogram`.',
            ),
          );
        }
        const snapshot = getSnapshot();
        const want = shape != null && shape.length > 0 ? new Set(shape) : null;

        const selector: Selector = {
          className: class_name,
          want,
          nodeType: node_type,
        };
        const all = selectNodes(snapshot, selector);

        if (all.length === 0) {
          return errorResult(
            new Error(
              `No node matched${class_name ? ` class \`${class_name}\`` : ''}${
                want != null ? ` shape [${[...want].join(', ')}]` : ''
              }${node_type != null ? ` of type \`${node_type}\`` : ''}. ` +
                'Check the name with `memlab_class_histogram({name_pattern})`, or the property set with `memlab_property_names`.',
            ),
          );
        }

        // Allocation order IS id order. Sorting the whole population is cheap
        // next to the pass that found it.
        all.sort((a, b) => a.id - b.id);
        const newest = all.slice(-Math.max(1, cohort));
        // No floor on the oldest slice. The whole report is newest-vs-oldest,
        // so forcing it to be non-empty when the population fits inside one
        // cohort puts `all[0]` on BOTH sides and reports a class as
        // disagreeing with itself. Empty is the honest answer there, and the
        // `oldest.length > 0` guard below already handles it.
        // Capped at `newest.length`, not at `cohort`. The two are the same
        // only when the population is at least twice the cohort; below that
        // the oldest slice is smaller, and the table calls it the "same size
        // sample" while the disagreement warning divides two different
        // denominators — a share against 3,000 read beside one against
        // 5,000.
        const oldest = all.slice(
          0,
          Math.min(newest.length, all.length - newest.length),
        );

        const lines: string[] = [
          `## Growth cohort — ${formatNumber(newest.length)} newest of ${formatNumber(all.length)}`,
          '',
          `Selector: ${[
            class_name ? `class \`${class_name}\`` : null,
            want != null ? `shape [${[...want].join(', ')}]` : null,
            node_type ? `type \`${node_type}\`` : null,
          ]
            .filter(Boolean)
            .join(', ')}.`,
          `Node ids ${formatNumber(newest[0].id)} … ${formatNumber(newest[newest.length - 1].id)} (the whole population spans ${formatNumber(all[0].id)} … ${formatNumber(all[all.length - 1].id)}).`,
          '',
        ];

        if (newest.length === all.length) {
          lines.push(
            `> The cohort IS the whole population (${formatNumber(all.length)} <= \`cohort\`), so there is no newest-vs-rest comparison below. Lower \`cohort\` to the growth the ladder measured to get one.`,
            '',
          );
        }

        const cohortRetained = combinedRetained(newest, snapshot);
        lines.push(
          `Dominator-deduped retained by the cohort: **${formatBytes(cohortRetained)}** ` +
            `(Σ self size ${formatBytes(newest.reduce((s, n) => s + n.self_size, 0))}).`,
          '',
        );

        if (group_by === 'referrer+shape') {
          lines.push(
            ...(await jointTable({
              snapshot,
              all,
              newest,
              selector,
              shapeKeys: shape_keys,
              top,
              baselinePath: baseline_path,
            })),
          );
          return toolResult(lines.join('\n'));
        }

        const sections: Array<{
          title: string;
          keyFn: (n: IHeapNode) => string;
          note: string;
        }> = [
          {
            title: 'Top referrer edges',
            keyFn: referrerEdgeLabel,
            note: 'Who points AT the new instances. This is the column a fix has to change.',
          },
          {
            title: 'Top shapes',
            keyFn: shapeLabel,
            note: 'What the new instances ARE. A single dominant shape means one record type is accumulating.',
          },
          {
            title: 'Top root-path heads',
            keyFn: rootPathHead,
            note: 'Which GC root the path ends at. One head over the whole cohort means one root cause.',
          },
        ];

        for (const s of sections) {
          const cohortRows = histogram(newest, s.keyFn, top);
          // The FULL count map, not the top 200. A newest key ranking below
          // 200 in the oldest distribution rendered as `0`, which reads as
          // "this retainer is newest-only" — the exact disagreement this
          // column exists to detect, manufactured out of a display cutoff.
          const restRows =
            oldest.length > 0
              ? new Map(
                  histogram(oldest, s.keyFn, Number.MAX_SAFE_INTEGER).map(r => [
                    r.key,
                    r.count,
                  ]),
                )
              : null;
          lines.push(`### ${s.title}`, '', `_${s.note}_`, '');
          lines.push(
            markdownTable(
              [
                s.title.replace('Top ', ''),
                'newest',
                'share',
                // The REAL size, not the claim "same size sample". The
                // oldest slice is capped at `newest.length` but the
                // population can be smaller than two cohorts, and then it is
                // genuinely shorter — at which point a raw count in this
                // column is not comparable with the one beside it, and a
                // header asserting otherwise is the reason a reader would
                // compare them anyway.
                ...(restRows != null
                  ? [
                      oldest.length === newest.length
                        ? 'oldest (same size sample)'
                        : `oldest (${formatNumber(oldest.length)} of ${formatNumber(newest.length)})`,
                    ]
                  : []),
              ],
              cohortRows.map(r => [
                r.key,
                formatNumber(r.count),
                share(r.count, newest.length),
                ...(restRows != null
                  ? [formatNumber(restRows.get(r.key) ?? 0)]
                  : []),
              ]),
              new Set([1, 2, 3]),
            ),
          );
          // The disagreement, stated rather than left to be spotted — but
          // only when the cohort actually has a dominant answer. Two 1% keys
          // differing is noise, and a warning fired on noise trains the
          // reader to skip the one that matters.
          const DOMINANT_SHARE = 0.2;
          if (
            restRows != null &&
            cohortRows.length > 0 &&
            cohortRows[0].count >= DOMINANT_SHARE * newest.length
          ) {
            const topKey = cohortRows[0].key;
            // From the map already built above, not a second histogram pass.
            // `restRows` IS the full oldest distribution; recomputing it ran
            // `keyFn` — a referrer-edge or shape lookup per node — over the
            // whole oldest cohort again, once per section.
            let oldTop: {key: string; count: number} | null = null;
            for (const [key, count] of restRows) {
              if (oldTop == null || count > oldTop.count) oldTop = {key, count};
            }
            if (oldTop != null && oldTop.key !== topKey) {
              lines.push(
                '',
                `⚠ **The newest and the oldest disagree here.** Newest: \`${topKey}\` (${share(cohortRows[0].count, newest.length)} of ${formatNumber(newest.length)}). ` +
                  `Oldest: \`${oldTop.key}\` (${share(oldTop.count, oldest.length)} of ${formatNumber(oldest.length)}). ` +
                  (oldest.length !== newest.length
                    ? 'The two samples are different sizes — the population is under two cohorts — so read the shares, not the counts. '
                    : '') +
                  'A retainer voted over the whole population would report the second, which is the one that did NOT grow.',
              );
            }
          }
          lines.push('');
        }

        lines.push(
          '_Allocation order is a HEURISTIC for recency: node ids are monotonic in allocation, but a class that churns ' +
            'recycles ids across the whole range, so a cohort taken from a churning class is not "the growth". Confirm with ' +
            '`memlab_ladder_probe` that the population is actually growing before reading this as a leak, and take the ' +
            'dominant referrer to `memlab_retainer_layers` to check it is the only door._',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
