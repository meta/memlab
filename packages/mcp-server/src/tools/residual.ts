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
import type {IHeapEdge, IHeapNode, IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {resolveSavedNodeIds} from '../result-handles.js';
import {getSnapshot} from '../heap-state.js';
import {recordLead} from '../lead-registry.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  heldByLabel,
  isNodeWorthInspecting,
  markdownTable,
  toolResult,
  topKBy,
  truncateNodeName,
} from '../utils.js';
import {findRootIds} from './what-if.js';

/**
 * "Explain, subtract, look again": cut every explained finding at once,
 * recompute what the GC roots reach, and census what is left.
 *
 * Same model as `memlab_what_if`'s cascade (its roots; weak edges do not
 * retain; cutting a node cuts every edge into it), but marks are indexed by
 * node index, not id: native nodes can carry pointer-sized ids (1.6e9 on a
 * 1.4M-node video capture), where id-indexed arrays are gigabytes.
 *
 * Cost: a baseline walk (cached per snapshot), ONE walk with every cut, then
 * per label a walk seeded from the cut edges and confined to what the combined
 * cut frees. A single cut frees a subset of that, so K labels cost K walks of
 * the freed set, not K walks of the heap.
 */

/** Label bitmasks keyed by node index. */
export interface CutPlan {
  labels: string[];
  /** Node index -> labels that remove the node (every edge into it). */
  removed: Map<number, number>;
  /** Holder class -> edge name -> labels. */
  byClass: Map<string, Map<string, number>>;
  /** Holder node index -> edge name -> labels. */
  byNode: Map<number, Map<string, number>>;
}

/** `Class.prop` split at every dot: class (`Window / https://x.com`) and edge (`Foo.react`) names both contain dots. */
export function edgeSpecSplits(spec: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = spec.indexOf('.'); i > 0; i = spec.indexOf('.', i + 1)) {
    if (i < spec.length - 1) out.push([spec.slice(0, i), spec.slice(i + 1)]);
  }
  return out;
}

function addMask<K>(
  m: Map<K, Map<string, number>>,
  k: K,
  e: string,
  bit: number,
) {
  const inner = m.get(k) ?? new Map<string, number>();
  inner.set(e, (inner.get(e) ?? 0) | bit);
  m.set(k, inner);
}

type Skip = (e: IHeapEdge, t: number) => boolean;

/** Depth-first mark from `stack`, skipping weak edges and whatever `skipFor(from)` says. */
function mark(
  snapshot: IHeapSnapshot,
  seen: Uint8Array,
  stack: number[],
  skipFor: (from: IHeapNode) => Skip | null,
  parent?: Int32Array,
): void {
  while (stack.length > 0) {
    const node = snapshot.nodes.get(stack.pop() as number);
    if (node == null) continue;
    const skip = skipFor(node);
    node.forEachReference(e => {
      const t = e.to_node;
      if (e.type === 'weak' || seen[t] === 1 || skip?.(e, t)) return;
      seen[t] = 1;
      if (parent != null) parent[t] = e.edgeIndex + 1;
      stack.push(t);
    });
  }
}

const baselines = new WeakMap<IHeapSnapshot, Uint8Array>();

function rootIndices(snapshot: IHeapSnapshot): number[] {
  return findRootIds(snapshot).flatMap(id => {
    const n = snapshot.getNodeById(id);
    return n == null ? [] : [n.nodeIndex];
  });
}

export interface ResidualResult {
  /** Node index -> reachable once every cut is made. */
  after: Uint8Array;
  /** Node index -> 1 + index of the edge that first reached it. */
  parent: Int32Array;
  freed: number[];
  combined: number;
  /** Bytes each label frees on its own. */
  alone: number[];
  /** Per label: cut edges met from a live holder. */
  doors: number[];
  /** Bytes freed by two or more single cuts (counted twice in their sum). */
  shared: number;
  /** Bytes no single cut frees, only the combination. */
  jointOnly: number;
}

export function computeResidual(
  snapshot: IHeapSnapshot,
  plan: CutPlan,
): ResidualResult {
  const N = snapshot.nodes.length;
  const K = plan.labels.length;
  const roots = rootIndices(snapshot);
  let before = baselines.get(snapshot);
  if (before == null) {
    before = new Uint8Array(N);
    for (const r of roots) before[r] = 1;
    mark(snapshot, before, [...roots], () => null);
    baselines.set(snapshot, before);
  }
  const removed = new Uint8Array(N);
  for (const idx of plan.removed.keys()) removed[idx] = 1;
  /** Labels cutting edge `e` (into `t`) out of `from`. */
  const maskOf = (from: IHeapNode): ((e: IHeapEdge, t: number) => number) => {
    const a = plan.byNode.get(from.nodeIndex);
    const b = plan.byClass.size > 0 ? plan.byClass.get(from.name) : undefined;
    return (e, t) => {
      const node = removed[t] === 1 ? (plan.removed.get(t) ?? 0) : 0;
      if (a == null && b == null) return node;
      const n = String(e.name_or_index);
      return node | (a?.get(n) ?? 0) | (b?.get(n) ?? 0);
    };
  };
  const doors = new Array<number>(K).fill(0);
  const countDoors = (m: number) => {
    for (let l = 0; l < K; l++) if (m & (1 << l)) doors[l]++;
  };
  // Cut edges met from live holders: where a single cut re-enters.
  const fTo: number[] = [];
  const fMask: number[] = [];
  const after = new Uint8Array(N);
  const parent = new Int32Array(N);
  for (const r of roots) after[r] = 1;
  mark(
    snapshot,
    after,
    [...roots],
    from => {
      const mask = maskOf(from);
      return (e, t) => {
        const m = mask(e, t);
        if (m === 0) return false;
        fTo.push(t);
        fMask.push(m);
        countDoors(m);
        return true;
      };
    },
    parent,
  );
  const freed: number[] = [];
  const self: number[] = [];
  let combined = 0;
  for (let i = 0; i < N; i++) {
    if (before[i] !== 1 || after[i] === 1) continue;
    freed.push(i);
    self.push(snapshot.nodes.get(i)?.self_size ?? 0);
    combined += self[self.length - 1];
  }
  const res = {after, parent, freed, combined, alone: [combined], doors};
  if (K <= 1) return {...res, shared: 0, jointOnly: 0};

  // Per label: what the combined cut frees but this label alone does not.
  const count = new Uint8Array(freed.length);
  const seen = new Uint8Array(N);
  res.alone = [];
  for (let l = 0; l < K; l++) {
    const bit = 1 << l;
    const live = (t: number) => before[t] === 1 && after[t] !== 1;
    const stack: number[] = [];
    for (let i = 0; i < fTo.length; i++) {
      const t = fTo[i];
      if (!(fMask[i] & bit) && seen[t] !== 1 && live(t)) {
        seen[t] = 1;
        stack.push(t);
      }
    }
    mark(snapshot, seen, stack, from => {
      const mask = maskOf(from);
      return (e, t) => {
        if (mask(e, t) & bit) {
          doors[l]++;
          return true;
        }
        return !live(t);
      };
    });
    let back = 0;
    for (let i = 0; i < freed.length; i++) {
      if (seen[freed[i]] === 1) {
        back += self[i];
        seen[freed[i]] = 0;
      } else if (count[i] < 255) {
        count[i]++;
      }
    }
    res.alone.push(combined - back);
  }
  let shared = 0;
  let jointOnly = 0;
  for (let i = 0; i < freed.length; i++) {
    if (count[i] === 0) jointOnly += self[i];
    else shared += self[i] * (count[i] - 1);
  }
  return {...res, shared, jointOnly};
}

/**
 * Freed bytes under each surviving dominator. A survivor's dominator survives
 * too (every root path runs through it), so each freed node climbs to its
 * nearest live dominator (memoized), and each of those climbs to the root.
 */
function freedUnder(snapshot: IHeapSnapshot, res: ResidualResult) {
  const memo = new Map<number, number>();
  const atLive = new Map<number, number>();
  for (const idx of res.freed) {
    const chain: number[] = [];
    let cur = idx;
    let live = memo.get(cur) ?? -1;
    while (!memo.has(cur)) {
      chain.push(cur);
      const d = snapshot.nodes.get(cur)?.dominatorNode;
      if (d == null || d.nodeIndex === cur) break;
      cur = d.nodeIndex;
      live = res.after[cur] === 1 ? cur : (memo.get(cur) ?? -1);
      if (res.after[cur] === 1) break;
    }
    for (const c of chain) memo.set(c, live);
    const s = snapshot.nodes.get(idx)?.self_size ?? 0;
    if (live >= 0) atLive.set(live, (atLive.get(live) ?? 0) + s);
  }
  const sub = new Map<number, number>();
  for (const [b, bytes] of atLive) {
    let node = snapshot.nodes.get(b);
    while (node != null) {
      sub.set(node.nodeIndex, (sub.get(node.nodeIndex) ?? 0) + bytes);
      const d: IHeapNode | null = node.dominatorNode;
      node = d == null || d.nodeIndex === node.nodeIndex ? null : d;
    }
  }
  return sub;
}

export interface NumberRow {
  cls: string;
  prop: string;
  count: number;
  bytes: number;
  sample: number;
}

/** Fold the properties of one holder class holding equally many heap numbers: one record type's fields. */
export function mergeNumberRows(
  rows: NumberRow[],
): Array<NumberRow & {props: string[]}> {
  const by = new Map<string, NumberRow & {props: string[]}>();
  for (const r of rows) {
    const m = by.get(`${r.cls}\u0000${r.count}`);
    if (m == null) {
      by.set(`${r.cls}\u0000${r.count}`, {...r, props: [r.prop]});
    } else {
      m.props.push(r.prop);
      m.bytes += r.bytes;
    }
  }
  const n = (r: NumberRow & {props: string[]}) => r.count * r.props.length;
  return [...by.values()].sort((a, b) => n(b) - n(a) || b.bytes - a.bytes);
}

const CONTAINERS = new Set(['Array', 'Map', 'Set', 'Object']);
const isContainer = (c: IHeapNode) =>
  c.type === 'array' ||
  /^(concatenated|sliced) string$/.test(c.type) ||
  CONTAINERS.has(c.name);
/** V8 bookkeeping holders (root lists, code metadata), not app state. */
const BOOKKEEPING = /^(system \/ |\()/;
const NOT_GROUPED = new Set([
  'array',
  'hidden',
  'code',
  'synthetic',
  'object shape',
]);
const BIG_ARRAY = 100 * 1024;

/**
 * One pass over what is left: top dominators by retained size minus what the
 * cuts free, holder `Class.edge` groups (`X[]` = an entry of the collection
 * held at X), heap-number holders, and arrays over 100 KB.
 */
function census(snapshot: IHeapSnapshot, res: ResidualResult, limit: number) {
  const sub = freedUnder(snapshot, res);
  const app = (n: IHeapNode) =>
    !/^(synthetic|code|hidden)$/.test(n.type) && !BOOKKEEPING.test(n.name);
  // The walk's first edge, unless V8 bookkeeping (a root list, code metadata)
  // found the node first: then a surviving app holder, if it has one.
  const edgeOf = (idx: number): IHeapEdge | null => {
    const e =
      res.parent[idx] > 0 ? snapshot.edges.get(res.parent[idx] - 1) : null;
    if (e == null || app(e.fromNode)) return e;
    let better: IHeapEdge | null = null;
    snapshot.nodes.get(idx)?.forEachReferrer(r => {
      const ok = r.type !== 'weak' && res.after[r.fromNode.nodeIndex] === 1;
      if (ok && app(r.fromNode)) better = r;
      return better != null ? {stop: true} : undefined;
    });
    return better ?? e;
  };
  const memo = new Map<number, string>();
  const holder = (idx: number, depth = 0): string => {
    const e = edgeOf(idx);
    if (e == null) return '(root)';
    const name = String(e.name_or_index);
    const from = e.fromNode;
    if (e.type === 'context') return `closure var ${name}`;
    const entry =
      e.type === 'element' || e.type === 'hidden' || /^\d+$/.test(name);
    if (!entry && !(e.type === 'internal' && isContainer(from))) {
      return `${from.name || '(anonymous)'}.${name}`;
    }
    let at = from.name || '(anonymous)';
    if (depth < 3 && isContainer(from)) {
      at = memo.get(from.nodeIndex) ?? holder(from.nodeIndex, depth + 1);
      memo.set(from.nodeIndex, at);
    }
    return entry ? `${at}[]` : at;
  };
  const top = topKBy<{node: IHeapNode; left: number}>(
    limit * 6 + 30,
    (a, b) => b.left - a.left,
  );
  const groups = new Map<
    string,
    {count: number; bytes: number; eg: IHeapNode}
  >();
  const numbers = new Map<string, NumberRow>();
  const arrays: IHeapNode[] = [];
  let leftBytes = 0;
  snapshot.nodes.forEach(node => {
    const idx = node.nodeIndex;
    if (res.after[idx] !== 1) return;
    leftBytes += node.self_size;
    if (isNodeWorthInspecting(node)) {
      top.push({node, left: node.retainedSize - (sub.get(idx) ?? 0)});
    }
    if (node.type === 'array' && node.self_size > BIG_ARRAY) arrays.push(node);
    if (node.type === 'number') {
      const e = node.name === 'heap number' ? edgeOf(idx) : null;
      if (e == null) return;
      const prop = String(e.name_or_index);
      const indexed = e.type === 'element' || /^\d+$/.test(prop);
      const cls = indexed ? holder(idx).replace(/\[\]$/, '') : e.fromNode.name;
      const key = `${cls}\u0000${indexed ? '[]' : prop}`;
      const r = numbers.get(key) ?? {
        cls,
        prop: indexed ? '[]' : prop,
        count: 0,
        bytes: 0,
        sample: e.fromNode.id,
      };
      r.count++;
      r.bytes += node.self_size;
      numbers.set(key, r);
    } else if (!NOT_GROUPED.has(node.type)) {
      const k = holder(idx);
      const g = groups.get(k) ?? {count: 0, bytes: 0, eg: node};
      g.count++;
      g.bytes += node.self_size;
      groups.set(k, g);
    }
  });
  // Views of one subtree (near-equal along a dominator chain) fold into the highest.
  const rows: Array<{node: IHeapNode; left: number}> = [];
  const picked = new Map<number, number>();
  for (const c of top.sorted()) {
    if (rows.length >= limit || c.left <= 0) break;
    let d = c.node.dominatorNode;
    let dup = false;
    for (let s = 0; d != null && s < 50 && !dup; s++) {
      dup = (picked.get(d.nodeIndex) ?? Infinity) * 0.99 <= c.left;
      const next: IHeapNode | null = d.dominatorNode;
      d = next?.nodeIndex === d.nodeIndex ? null : next;
    }
    if (dup) continue;
    picked.set(c.node.nodeIndex, c.left);
    rows.push(c);
  }
  const small = Math.min(limit, 15);
  return {
    leftBytes,
    top: rows,
    groups: [...groups.entries()]
      .filter(([k, g]) => g.count > 1 && !BOOKKEEPING.test(k))
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .slice(0, limit),
    numbers: mergeNumberRows(
      [...numbers.values()].filter(r => !BOOKKEEPING.test(r.cls)),
    ).slice(0, small),
    arrays: arrays
      .sort((a, b) => b.self_size - a.self_size)
      .slice(0, small)
      .map(node => ({node, holder: holder(node.nodeIndex)})),
  };
}

const explainedEntry = z.object({
  label: z.string().describe('Name of the finding, e.g. "I1 DebugOwl Map".'),
  node_ids: z
    .array(z.number())
    .optional()
    .describe('Objects to cut (every edge into them).'),
  from_result: z
    .string()
    .optional()
    .describe('A saved id set (memlab_eval save_as) in place of node_ids.'),
  class: z
    .string()
    .optional()
    .describe('Every instance of this class (exact name).'),
  edge: z
    .string()
    .optional()
    .describe(
      'Cut edges instead of nodes: `Class.prop` cuts that property out of every instance of Class; with `node_ids`/`from_result`/`class`, a bare `prop` cuts it out of those holders only.',
    ),
});

function buildPlan(
  snapshot: IHeapSnapshot,
  explained: Array<z.infer<typeof explainedEntry>>,
): CutPlan {
  const plan: CutPlan = {
    labels: [],
    removed: new Map(),
    byClass: new Map(),
    byNode: new Map(),
  };
  const remove = (idx: number, bit: number) =>
    plan.removed.set(idx, (plan.removed.get(idx) ?? 0) | bit);
  const classCuts = new Map<string, number>();
  for (const x of explained) {
    // Entries sharing a label are one finding with several doors.
    const l = plan.labels.includes(x.label)
      ? plan.labels.indexOf(x.label)
      : plan.labels.push(x.label) - 1;
    if (l >= 30) throw new Error('At most 30 distinct labels per call.');
    const bit = 1 << l;
    const ids =
      x.from_result != null ? resolveSavedNodeIds(x.from_result) : x.node_ids;
    if (
      (x.from_result != null && x.node_ids != null) ||
      (ids != null && x.class != null)
    ) {
      throw new Error(
        `"${x.label}": pass one of node_ids / from_result / class.`,
      );
    }
    if (x.edge != null && x.class != null) {
      addMask(plan.byClass, x.class, x.edge, bit);
    } else if (x.class != null) {
      classCuts.set(x.class, (classCuts.get(x.class) ?? 0) | bit);
    } else if (ids != null) {
      for (const id of ids) {
        const idx = snapshot.getNodeById(id)?.nodeIndex;
        if (idx != null && x.edge != null)
          addMask(plan.byNode, idx, x.edge, bit);
        else if (idx != null) remove(idx, bit);
      }
    } else if (x.edge != null && edgeSpecSplits(x.edge).length > 0) {
      for (const [c, p] of edgeSpecSplits(x.edge))
        addMask(plan.byClass, c, p, bit);
    } else {
      throw new Error(
        `"${x.label}": pass node_ids, from_result, class, or an edge as \`Class.prop\`.`,
      );
    }
  }
  if (classCuts.size > 0) {
    snapshot.nodes.forEach(n => {
      const bit = classCuts.get(n.name);
      if (bit != null && n.id > 3) remove(n.nodeIndex, bit);
    });
  }
  return plan;
}

const clip = (s: string, n: number) =>
  s.length > n ? s.slice(0, n - 1) + '…' : s;

export function registerResidual(server: McpServer): void {
  server.tool(
    'memlab_residual',
    'What is left once the explained findings are fixed? Cuts every explained entry at once, recomputes reachability from the GC roots, and reports: the bytes each cut frees alone and all of them together, with the overlap (together < sum when cuts free the same memory, > sum when only the combination frees it); the top remaining dominators; and a census of what is still reachable by holder `Class.edge`, by heap-number holder, and arrays over 100 KB.\n\n' +
      'Use it once the big items are explained, to find the long tail and to size a set of fixes (`memlab_what_if` sizes one population, without edge cuts). Add what you explain from the residual as a new entry and call again.',
    {
      explained: z
        .array(explainedEntry)
        .min(1)
        .max(60)
        .describe(
          'The explained findings. Each entry names nodes (`node_ids`, `from_result`, `class`) and/or an `edge`; entries sharing a `label` are one finding with several doors.',
        ),
      limit: z
        .number()
        .optional()
        .default(15)
        .describe('Rows per table (default 15).'),
    },
    async ({explained, limit}) => {
      try {
        const t0 = Date.now();
        const snapshot = getSnapshot();
        const plan = buildPlan(snapshot, explained);
        const res = computeResidual(snapshot, plan);
        const c = census(snapshot, res, limit);
        for (const {node, left} of c.top.slice(0, 15)) {
          const why = `${formatBytes(left)} left after the explained cuts`;
          recordLead(snapshot, {
            node,
            bytes: left,
            kind: 'residual',
            why,
            source: 'residual',
          });
        }
        const K = plan.labels.length;
        const labelRows = plan.labels.map((l, i) => [
          l,
          formatNumber(res.doors[i]),
          formatBytes(res.alone[i]),
        ]);
        if (K > 1)
          labelRows.push(['**together**', '', formatBytes(res.combined)]);
        const lines = [
          `## Residual after ${K} explained cut(s)`,
          '',
          `**All cuts together free ${formatBytes(res.combined)}** (${formatNumber(res.freed.length)} nodes); ${formatBytes(c.leftBytes)} stays reachable.`,
          '',
          `Reachability from the GC roots, weak edges not retaining: ${K > 1 ? `2 full walks + ${K} over the freed set` : '2 full walks'}, ${((Date.now() - t0) / 1000).toFixed(1)} s.`,
          '',
          markdownTable(
            ['Label', 'Doors cut', 'Frees alone'],
            labelRows,
            new Set([1, 2]),
          ),
        ];
        const none = plan.labels.filter((_, i) => res.doors[i] === 0);
        if (none.length > 0) {
          lines.push(
            '',
            `⚠ Matched nothing reachable: ${none.join(', ')}. Check the ids, class or edge name.`,
          );
        }
        if (K > 1) {
          lines.push(
            '',
            `Sum of the single cuts: ${formatBytes(res.alone.reduce((a, b) => a + b, 0))}. ${formatBytes(res.shared)} is freed by more than one cut (counted twice in the sum); ${formatBytes(res.jointOnly)} is freed only when cuts are combined.`,
          );
        }
        const name = (n: IHeapNode, len: number) =>
          truncateNodeName(n.name, n.type, n.self_size, len);
        const section = (
          title: string,
          note: string,
          headers: string[],
          rows: string[][],
          right: number[],
        ) => {
          if (rows.length === 0) return;
          lines.push('', `### ${title}`, '', ...(note ? [note, ''] : []));
          lines.push(markdownTable(headers, rows, new Set(right)));
        };
        section(
          'Top remaining dominators',
          'Retained left = original retained size minus what the cuts free under it; a floor (memory the cuts leave to one owner is not re-attributed).',
          ['ID', 'Name', 'Type', 'Retained left', 'Held by'],
          c.top.map(({node, left}) => [
            `@${node.id}`,
            name(node, 50),
            node.type,
            formatBytes(left),
            heldByLabel(node),
          ]),
          [3],
        );
        section(
          'Remaining holder groups (self bytes)',
          'Held by = the first edge reaching the object from the GC roots after the cuts; `X[]` = an entry of the collection held at X.',
          ['Held by', 'Count', 'Self', 'e.g.'],
          c.groups.map(([k, g]) => [
            clip(k, 60),
            formatNumber(g.count),
            formatBytes(g.bytes),
            `${name(g.eg, 30)} @${g.eg.id}`,
          ]),
          [1, 2],
        );
        section(
          'Heap numbers `(number)` by holder',
          '',
          ['Holder', 'Numbers', 'Bytes', 'e.g. holder'],
          c.numbers.map(r => [
            (r.props.length > 1
              ? `${r.cls}.{${r.props.join(', ')}}`
              : `${r.cls}.${r.prop}`
            )
              .replace(/\.\[\]$/, '[]')
              .replace(/^(.{69}).+$/, '$1…'),
            (r.props.length > 1 ? `${r.props.length} × ` : '') +
              formatNumber(r.count),
            formatBytes(r.bytes),
            `@${r.sample}`,
          ]),
          [1, 2],
        );
        section(
          'Arrays over 100 KB',
          '',
          ['ID', 'Name', 'Self', 'Entries', 'Held by'],
          c.arrays.map(({node, holder}) => [
            `@${node.id}`,
            name(node, 30),
            formatBytes(node.self_size),
            formatNumber(node.edge_count),
            holder,
          ]),
          [2, 3],
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
