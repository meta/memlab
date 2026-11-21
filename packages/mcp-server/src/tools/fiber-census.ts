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
 * What the mounted React tree is made of, per repeated list item.
 *
 * Class counts say "1,408 CometGHLFakeElement fibers"; they cannot say that
 * this is 44 per rendered feed story times 32 rendered stories, or that 111
 * of the 143 loaded stories are 42-fiber virtualized shells. Both are visible
 * only from the committed tree's SHAPE: a list is a fiber with many children
 * of one type, each item's subtree size tells rendered from collapsed, and
 * per-item type counts give the multiplier of each heavy child.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  edgeTo,
  fiberComponentName,
  fiberRenderFunction,
  isFiberNode,
} from '../react-shapes.js';
import {
  armScanBudgetFor,
  resolveRungs,
  scaledTimeoutMs,
  withSnapshotAt,
} from '../snapshot-borrow.js';
import {freedByReleasing, reachabilityOf} from './what-if.js';
import type {Reachability} from './what-if.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/** The committed tree in preorder: a subtree is `[i, i + size[i])`. */
export interface FiberTree {
  nodes: IHeapNode[];
  names: string[];
  parent: number[];
  size: number[];
  alternates: number;
  /** Fibers renamed `name@id`: their name is shared by other functions. */
  split: number;
}

/** A component name, or `<div>` / `(…)` / `{…}` for host and anonymous ones. */
export function isNamedComponent(name: string): boolean {
  return !/^[<({]/.test(name);
}

function fiberName(fiber: IHeapNode, cache: Map<number, string>): string {
  const et = edgeTo(fiber, 'elementType');
  if (et == null || et.type === 'hidden') return '(root/fragment)';
  const hit = cache.get(et.id);
  if (hit != null) return hit;
  let name = fiberComponentName(fiber);
  if (name == null) {
    const ctx = edgeTo(et, '_context');
    const dn = edgeTo(ctx ?? et, 'displayName');
    const label = dn?.isString ? dn.toStringNode()?.stringValue : null;
    if (ctx != null) name = `${label ?? '{Context}'}.Provider`;
    else if (edgeTo(et, '_currentValue') != null)
      name = `${label ?? '{Context}'}.Consumer`;
    else name = label ?? `{${et.name || et.type}}`;
  }
  cache.set(et.id, name);
  return name;
}

/** Every committed tree, from the roots that carry `containerInfo` + `current`. */
export function mountedFiberTree(snapshot: IHeapSnapshot): FiberTree {
  const tree: FiberTree = {
    nodes: [],
    names: [],
    parent: [],
    size: [],
    alternates: 0,
    split: 0,
  };
  const stack: Array<[IHeapNode, number]> = [];
  snapshot.nodes.forEach((n: IHeapNode) => {
    if (n.type !== 'object' || edgeTo(n, 'containerInfo') == null) return;
    const current = edgeTo(n, 'current');
    if (current != null && isFiberNode(current)) stack.push([current, -1]);
  });
  const seen = new Set<number>();
  const cache = new Map<number, string>();
  const identity: number[] = [];
  const identities = new Map<string, Set<number>>();
  while (stack.length > 0) {
    const [f, p] = stack.pop() as [IHeapNode, number];
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    const idx = tree.nodes.length;
    tree.nodes.push(f);
    const name = fiberName(f, cache);
    tree.names.push(name);
    if (isNamedComponent(name) && name.length <= 2) {
      // A minified build gives unrelated components one short name ("a").
      const id =
        fiberRenderFunction(f)?.id ?? edgeTo(f, 'elementType')?.id ?? 0;
      identity[idx] = id;
      if (!identities.has(name)) identities.set(name, new Set());
      identities.get(name)?.add(id);
    }
    tree.parent.push(p);
    tree.size.push(1);
    if (edgeTo(f, 'alternate')?.type === 'object') tree.alternates++;
    const kids: IHeapNode[] = [];
    for (
      let c = edgeTo(f, 'child');
      c != null && c.type === 'object' && !seen.has(c.id) && kids.length < 1e5;
      c = edgeTo(c, 'sibling')
    ) {
      kids.push(c);
    }
    for (let k = kids.length - 1; k >= 0; k--) stack.push([kids[k], idx]);
  }
  for (let i = tree.nodes.length - 1; i > 0; i--) {
    if (tree.parent[i] >= 0) tree.size[tree.parent[i]] += tree.size[i];
  }
  tree.names.forEach((name, i) => {
    if ((identities.get(name)?.size ?? 0) < 2) return;
    tree.names[i] = `${name}@${identity[i]}`;
    tree.split++;
  });
  return tree;
}

/** Nearest named component strictly above `i`. */
function namedAncestor(tree: FiberTree, i: number): string {
  for (let p = tree.parent[i]; p >= 0; p = tree.parent[p]) {
    if (isNamedComponent(tree.names[p])) return tree.names[p];
  }
  return '(root)';
}

export interface Bucket {
  count: number;
  min: number;
  max: number;
  median: number;
  /** 1-based item positions when the bucket is one contiguous run. */
  range: [number, number] | null;
  /** Named types most of this bucket's items have and the others lack. */
  marks: string[];
  example: number;
}

/**
 * Split item subtree sizes where one sorted size is more than twice the
 * previous: rendered stories vs collapsed shells, 2,159 vs 42 fibers.
 */
export function bucketSizes(
  sizes: number[],
  ids: number[] = sizes.map((_, i) => i),
): Bucket[] {
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[a] - sizes[b]);
  const groups: number[][] = [];
  for (const i of order) {
    const g = groups[groups.length - 1];
    if (g != null && sizes[i] <= 2 * sizes[g[g.length - 1]]) g.push(i);
    else groups.push([i]);
  }
  return groups.map(g => {
    const pos = [...g].sort((a, b) => a - b);
    const contiguous = pos[pos.length - 1] - pos[0] === pos.length - 1;
    return {
      count: g.length,
      min: sizes[g[0]],
      max: sizes[g[g.length - 1]],
      median: sizes[g[Math.floor(g.length / 2)]],
      range: contiguous ? [pos[0] + 1, pos[pos.length - 1] + 1] : null,
      example: ids[g[g.length - 1]],
      marks: [],
    };
  });
}

export interface ChildRow {
  name: string;
  total: number;
  /** Instances not nested in another of the same type. */
  outer: number;
  perMin: number;
  perMax: number;
  /** Items outside the rendered bucket that contain this type. */
  inOthers: number;
  /** Fibers under each outermost instance, on average. */
  subtree: number;
  example: number;
  holder: string;
  also: string[];
  bytes: number | null;
}

export interface ListGroup {
  key: string;
  label: string;
  parentId: number;
  lists: number;
  items: number;
  buckets: Bucket[];
  rendered: number;
  rows: ChildRow[];
}

export interface FiberCensus {
  mounted: number;
  alternates: number;
  /** Component names shared by different functions, split as `name@id`. */
  split: number;
  topTypes: Array<{name: string; count: number}>;
  groups: ListGroup[];
}

interface Acc {
  total: number;
  perMin: number;
  perMax: number;
  outer: number;
  outerSize: number;
  example: number;
  ancestors: Set<string>;
}

/**
 * Per-type counts in one item; with `into`, also each named type's outermost
 * instances (not nested in the same type) and their subtree sizes.
 */
function scanItem(
  tree: FiberTree,
  root: number,
  into: Map<string, Acc> | null,
  scanned: number,
): Map<string, number> {
  const hist = new Map<string, number>();
  const open: number[] = [];
  const depth = new Map<string, number>();
  for (let j = root; j < root + tree.size[root]; j++) {
    while (open.length > 0) {
      const o = open[open.length - 1];
      if (j < o + tree.size[o]) break;
      open.pop();
      depth.set(tree.names[o], (depth.get(tree.names[o]) ?? 1) - 1);
    }
    const name = tree.names[j];
    hist.set(name, (hist.get(name) ?? 0) + 1);
    if (into != null && j > root && isNamedComponent(name)) {
      let a = into.get(name);
      if (a == null) {
        const ancestors = new Set(open.map(o => tree.names[o]));
        // Rendered items scanned before this type appeared held none of it.
        const perMin = scanned > 0 ? 0 : Infinity;
        a = {
          total: 0,
          perMin,
          perMax: 0,
          outer: 0,
          outerSize: 0,
          example: j,
          ancestors,
        };
        into.set(name, a);
      }
      a.total++;
      if ((depth.get(name) ?? 0) === 0) {
        a.outer++;
        a.outerSize += tree.size[j];
      }
    }
    open.push(j);
    depth.set(name, (depth.get(name) ?? 0) + 1);
  }
  return hist;
}

/** Distinct named types in subtree `i`, in preorder. */
function namesIn(tree: FiberTree, i: number): string[] {
  const out = new Set<string>();
  for (let j = i; j < i + tree.size[i]; j++)
    if (isNamedComponent(tree.names[j])) out.add(tree.names[j]);
  return [...out];
}

/**
 * Ids to cut to remove the outermost `name` subtrees below `items`: their
 * fibers, the fibers' alternates and the host DOM nodes they render.
 */
function subtreeCut(tree: FiberTree, items: number[], name: string): number[] {
  const ids: number[] = [];
  for (const i of items) {
    for (let r = i + 1; r < i + tree.size[i]; r++) {
      if (tree.names[r] !== name) continue;
      for (let j = r; j < r + tree.size[r]; j++) {
        const f = tree.nodes[j];
        ids.push(f.id);
        const alt = edgeTo(f, 'alternate');
        if (alt?.type === 'object') ids.push(alt.id);
        const dom = tree.names[j].startsWith('<')
          ? edgeTo(f, 'stateNode')
          : null;
        if (dom?.type === 'native') ids.push(dom.id);
      }
      r += tree.size[r] - 1;
    }
  }
  return ids;
}

export interface CensusOptions {
  minItems?: number;
  lists?: number;
  rows?: number;
  /** Removal bytes for this many top rows of each group (a BFS each). */
  bytesRows?: number;
  /** Take only lists with these keys, at any size: earlier ladder rungs. */
  keys?: Set<string>;
}

export function fiberCensus(
  snapshot: IHeapSnapshot,
  opts: CensusOptions = {},
): FiberCensus {
  const minItems = opts.minItems ?? 10;
  const tree = mountedFiberTree(snapshot);
  const n = tree.nodes.length;
  const typeCount = new Map<string, number>();
  for (const name of tree.names)
    typeCount.set(name, (typeCount.get(name) ?? 0) + 1);
  const topTypes = [...typeCount]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({name, count}));
  // Lists: a fiber's children grouped by type, aggregated across parents with
  // the same owner / parent / item type (32 decoy wrappers are one group).
  const byParent = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    if (tree.parent[i] < 0) continue;
    const k = `${tree.parent[i]} ${tree.names[i]}`;
    const list = byParent.get(k);
    if (list != null) list.push(i);
    else byParent.set(k, [i]);
  }
  const raw = new Map<
    string,
    {parentId: number; lists: number; items: number[]}
  >();
  for (const items of byParent.values()) {
    const p = tree.parent[items[0]];
    const key = `${namedAncestor(tree, p)} / ${tree.names[p]} / ${tree.names[items[0]]}`;
    if (opts.keys != null ? !opts.keys.has(key) : items.length < minItems)
      continue;
    const g = raw.get(key) ?? {parentId: tree.nodes[p].id, lists: 0, items: []};
    g.lists++;
    g.items.push(...items);
    raw.set(key, g);
  }
  const fibers = (items: number[]) =>
    items.reduce((s, i) => s + tree.size[i], 0);
  const ranked = [...raw]
    .filter(
      ([, g]) => opts.keys != null || fibers(g.items) >= Math.max(50, 0.02 * n),
    )
    .sort((a, b) => fibers(b[1].items) - fibers(a[1].items));
  const shown = new Set<number>();
  const groups: ListGroup[] = [];
  let reach: Reachability | null = null;
  for (const [key, g] of ranked) {
    if (groups.length >= (opts.lists ?? 3)) break;
    const inside = (i: number) => {
      for (let p = tree.parent[i]; p >= 0; p = tree.parent[p])
        if (shown.has(p)) return true;
      return false;
    };
    if (opts.keys == null && g.items.some(inside)) continue;
    for (const i of g.items) shown.add(i);
    const buckets = bucketSizes(
      g.items.map(i => tree.size[i]),
      g.items,
    );
    const last = buckets.length - 1;
    const top = buckets[last];
    // Per bucket, how many of its items contain each type.
    const has = buckets.map(() => new Map<string, number>());
    const once = new Map<string, number>();
    const acc = new Map<string, Acc>();
    const rendered: number[] = [];
    for (const i of g.items) {
      const k = buckets.findIndex(b => tree.size[i] <= b.max);
      const hist = scanItem(tree, i, k === last ? acc : null, rendered.length);
      for (const [t, c] of hist) {
        has[k].set(t, (has[k].get(t) ?? 0) + 1);
        if (c === 1) once.set(t, (once.get(t) ?? 0) + 1);
      }
      if (k !== last) continue;
      rendered.push(i);
      for (const [t, a] of acc) {
        a.perMin = Math.min(a.perMin, hist.get(t) ?? 0);
        a.perMax = Math.max(a.perMax, hist.get(t) ?? 0);
      }
    }
    const itemsWith = (t: string, skip: number) =>
      has.reduce((s, m, x) => s + (x === skip ? 0 : (m.get(t) ?? 0)), 0);
    if (buckets.length > 1) {
      buckets.forEach((b, k) => {
        b.marks = namesIn(tree, b.example)
          .filter(
            t =>
              (has[k].get(t) ?? 0) >= 0.9 * b.count &&
              has.every(
                (m, x) => x === k || (m.get(t) ?? 0) <= 0.1 * buckets[x].count,
              ),
          )
          .slice(0, 2);
      });
    }
    // Item identity: named types nearly every item has once, outermost first.
    const chain = namesIn(tree, g.items[0])
      .filter(t => (once.get(t) ?? 0) >= 0.9 * g.items.length)
      .slice(0, 6);
    const shells = g.items.length - top.count;
    const rows: ChildRow[] = [];
    const cands = [...acc]
      .filter(
        ([t, a]) =>
          // Wrappers around most of an item, and the shell every item shares,
          // are structure; a row is a part the item is built from.
          a.outerSize / a.outer <= 0.25 * top.median &&
          !(
            a.perMax <= 1 &&
            itemsWith(t, last) >= 0.9 * shells &&
            (shells > 0 || chain.includes(t))
          ),
      )
      .sort((a, b) => b[1].outerSize - a[1].outerSize);
    for (const [t, a] of cands) {
      if (rows.length >= (opts.rows ?? 8)) break;
      const same = rows.find(
        r => r.total === a.total && a.ancestors.has(r.name),
      );
      if (same != null) {
        if (same.also.length < 3) same.also.push(t);
        continue;
      }
      if (
        a.perMax <= 1 &&
        rows.some(r => r.perMax <= 1 && a.ancestors.has(r.name))
      )
        continue;
      rows.push({
        name: t,
        total: a.total,
        outer: a.outer,
        perMin: a.perMin,
        perMax: a.perMax,
        inOthers: itemsWith(t, last),
        subtree: Math.round(a.outerSize / a.outer),
        example: tree.nodes[a.example].id,
        holder: namedAncestor(tree, a.example),
        also: [],
        bytes: null,
      });
    }
    for (const r of rows.slice(0, opts.bytesRows ?? 0)) {
      reach ??= reachabilityOf(snapshot);
      r.bytes = freedByReleasing(
        snapshot,
        subtreeCut(tree, rendered, r.name),
        reach,
      ).bytes;
    }
    groups.push({
      key,
      label: chain.length > 0 ? chain.join(' › ') : key.split(' / ')[2],
      parentId: g.parentId,
      lists: g.lists,
      items: g.items.length,
      buckets: buckets.map(b => ({...b, example: tree.nodes[b.example].id})),
      rendered: rendered.length,
      rows,
    });
  }
  return {
    mounted: n,
    alternates: tree.alternates,
    split: tree.split,
    topTypes,
    groups,
  };
}

const per = (r: ChildRow) =>
  r.perMin === r.perMax
    ? formatNumber(r.perMax)
    : `${formatNumber(r.perMin)}–${formatNumber(r.perMax)}`;

function bucketText(b: Bucket, ordered = true): string {
  const size =
    b.min === b.max
      ? `${formatNumber(b.min)}`
      : `${formatNumber(b.min)}–${formatNumber(b.max)}`;
  const where = !ordered
    ? 'several lists'
    : b.range != null
      ? `items #${b.range[0]}–#${b.range[1]} in order`
      : 'scattered';
  const marks =
    b.marks.length > 0 ? `; only these have ${b.marks.join(', ')}` : '';
  return `${formatNumber(b.count)} with ${size} fibers (${where}, e.g. @${b.example}${marks})`;
}

function groupHeader(g: ListGroup): string[] {
  const [owner, parent] = g.key.split(' / ');
  const lists = g.lists > 1 ? ` across ${formatNumber(g.lists)} lists` : '';
  const out = [
    `### ${formatNumber(g.items)} items${lists}: ${g.label}`,
    `- List parent ${parent} @${g.parentId} under ${owner}`,
    ...g.buckets.map(b => `- ${bucketText(b, g.lists === 1)}`),
  ];
  if (g.buckets.length > 1) {
    const small = g.buckets[0];
    out.push(
      `- **Only ${formatNumber(g.rendered)} of ${formatNumber(g.items)} items are rendered.** The other ${formatNumber(g.items - g.rendered)} hold ${formatNumber(small.min)}–${formatNumber(g.buckets[g.buckets.length - 2].max)} fibers each (placeholders or collapsed/virtualized shells; their bodies are not mounted).`,
    );
  }
  return out;
}

export function renderGroup(g: ListGroup, withBytes: boolean): string[] {
  const out = groupHeader(g);
  if (g.rows.length === 0) return out;
  const where =
    g.buckets.length > 1
      ? `${formatNumber(g.rendered)} rendered items`
      : 'every item';
  out.push(
    '',
    markdownTable(
      [
        `Child type (in ${where})`,
        'Per item',
        'Total',
        'In other items',
        'Fibers each',
        ...(withBytes ? ['Frees if removed'] : []),
        'e.g. (in)',
      ],
      g.rows.map(r => [
        r.name +
          (r.also.length > 0 ? ` (same count: ${r.also.join(', ')})` : ''),
        per(r),
        formatNumber(r.total),
        formatNumber(r.inOthers),
        formatNumber(r.subtree),
        ...(withBytes
          ? [
              r.bytes == null
                ? ''
                : `${formatBytes(r.bytes)} (~${formatBytes(Math.round(r.bytes / Math.max(1, r.outer)))} each)`,
            ]
          : []),
        `@${r.example} (${r.holder})`,
      ]),
      new Set([1, 2, 3, 4]),
    ),
  );
  return out;
}

/** Compact sweep section: top list groups and their heavy children. */
export function fiberCensusSweepSection(snapshot: IHeapSnapshot): string[] {
  const c = fiberCensus(snapshot, {lists: 2, rows: 5});
  if (c.groups.length === 0) return [];
  const out = [
    '## React lists (fiber census)',
    '',
    `- ${formatNumber(c.mounted)} mounted fibers; removal bytes per row → \`memlab_fiber_census\``,
  ];
  for (const g of c.groups) out.push('', ...renderGroup(g, false));
  return [...out, ''];
}

function ladderText(labels: string[], census: FiberCensus[]): string {
  const last = census[census.length - 1];
  const out = ['## Fiber census per snapshot', ''];
  for (const g of last.groups) {
    const series = census.map(c => c.groups.find(x => x.key === g.key));
    out.push(...groupHeader(g), '');
    out.push(
      markdownTable(
        ['Snapshot', 'Items', 'Rendered', 'Fibers per item'],
        series.map((s, i) => [
          labels[i],
          formatNumber(s?.items ?? 0),
          formatNumber(s?.rendered ?? 0),
          s?.buckets
            .map(b => `${formatNumber(b.count)}×${formatNumber(b.median)}`)
            .join(' + ') ?? '',
        ]),
        new Set([1, 2]),
      ),
      '',
    );
    const first = series[0];
    const dItems = g.rendered - (first?.rendered ?? 0);
    out.push(
      markdownTable(
        [
          'Child type',
          ...labels.map(l => `${l} total (per item)`),
          'Δ',
          'Δ reads as',
          'Last: frees if removed',
          'e.g.',
        ],
        g.rows.map(r => {
          const cells = series.map(s => s?.rows.find(x => x.name === r.name));
          const base = cells[0]?.total ?? 0;
          const delta = r.total - base;
          const steady = cells.every(
            c => c != null && c.perMin === r.perMin && c.perMax === r.perMax,
          );
          const reads =
            steady && r.perMin === r.perMax
              ? `${dItems >= 0 ? '+' : ''}${formatNumber(dItems)} rendered items × ${formatNumber(r.perMax)}`
              : `items ${dItems >= 0 ? '+' : ''}${formatNumber(dItems)}, per item ${cells[0] != null ? per(cells[0]) : '0'} → ${per(r)}`;
          return [
            r.name,
            ...cells.map(c =>
              c == null ? '0' : `${formatNumber(c.total)} (${per(c)})`,
            ),
            `${delta >= 0 ? '+' : ''}${formatNumber(delta)}`,
            reads,
            r.bytes == null ? '' : formatBytes(r.bytes),
            `@${r.example} (${r.holder})`,
          ];
        }),
        new Set(labels.map((_, i) => i + 1)),
      ),
      '',
    );
  }
  return out.join('\n');
}

export function registerFiberCensus(server: McpServer): void {
  server.tool(
    'memlab_fiber_census',
    'What the mounted React tree is made of, per repeated list item. Walks the committed fiber tree from each root, finds lists (a fiber with many children of one component type, aggregated across parents), splits the items by subtree size (rendered vs collapsed/virtualized shells, with their positions) and, for the rendered items, gives each heavy child type its per-item multiplier, total, count in the other items, fibers per instance and the bytes freed if those subtrees (fibers, alternates, host DOM) were removed. With `paths`, the same per snapshot with deltas, so growth reads as "+31 rendered items × 44".',
    {
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Snapshot files, OLDEST FIRST, instead of the active snapshot.',
        ),
      min_items: z
        .number()
        .int()
        .min(2)
        .optional()
        .default(10)
        .describe('Children of one type that make a list (default 10).'),
      bytes_rows: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(3)
        .describe(
          'Rows per list that get removal bytes, one reachability pass each (default 3; 0 skips).',
        ),
    },
    async ({paths, min_items, bytes_rows}) => {
      try {
        const opts = {minItems: min_items, bytesRows: bytes_rows};
        const files = paths ?? [];
        if (files.length < 2) {
          const c =
            files.length === 1
              ? await withSnapshotAt(
                  resolveRungs(files).rungs[0].localPath,
                  s => fiberCensus(s, opts),
                )
              : fiberCensus(getSnapshot(), opts);
          if (c.mounted === 0)
            return toolResult(
              'No mounted React fiber tree (no root with `containerInfo` and a fiber `current`).',
            );
          const out = [
            '## Fiber census',
            '',
            `- ${formatNumber(c.mounted)} mounted fibers, ${formatNumber(c.alternates)} with an alternate`,
            ...(c.split > 0
              ? [
                  `- ⚠ ${formatNumber(c.split)} fibers use a 1-2 character component name that several functions share (as in a minified build); told apart as \`name@<function id>\``,
                ]
              : []),
            `- Most common: ${c.topTypes.map(t => `${t.name} ${formatNumber(t.count)}`).join(', ')}`,
          ];
          for (const g of c.groups)
            out.push('', ...renderGroup(g, bytes_rows > 0));
          if (c.groups.length === 0)
            out.push(
              '',
              `No list with ${min_items}+ items of one component type.`,
            );
          return toolResult(out.join('\n'));
        }
        const {rungs: resolved, largestMB} = resolveRungs(files);
        const results: FiberCensus[] = new Array(resolved.length);
        // The last rung picks the lists; earlier rungs report the same keys at any size.
        for (let i = resolved.length - 1; i >= 0; i--) {
          armScanBudgetFor(scaledTimeoutMs(largestMB));
          const keys =
            i === resolved.length - 1
              ? undefined
              : new Set(results[resolved.length - 1].groups.map(g => g.key));
          results[i] = await withSnapshotAt(resolved[i].localPath, s =>
            fiberCensus(
              s,
              keys ? {...opts, bytesRows: 0, keys, rows: 1e4} : opts,
            ),
          );
        }
        if (results[results.length - 1].groups.length === 0) {
          return toolResult(
            `No list with ${min_items}+ items of one component type in the last snapshot.`,
          );
        }
        return toolResult(
          ladderText(
            resolved.map((_, i) => `#${i + 1}`),
            results,
          ),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
