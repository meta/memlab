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
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {getCurrentHandle, getSnapshot, setSavedResult} from '../heap-state.js';
import {
  edgeTo,
  fiberComponentName,
  fiberRenderFunction,
} from '../react-shapes.js';
import {isDetachedElementName} from '../dom-names.js';
import {moduleOfScope} from '../module-registry.js';
import {
  enumerateMapEntries,
  enumerateSetElements,
  errorResult,
  flattenString,
  formatBytes,
  formatNumber,
  heldByLabel,
  markdownTable,
  sanitizeForTable,
  toolResult,
} from '../utils.js';
import {isDetachedDOMNode} from './detached-dom.js';

/**
 * Live React state that still points at dead UI, found from the React side:
 *
 * (a) An effect cleanup (`effect.inst.destroy`, or `effect.destroy` before
 *     React 18.3) on a MOUNTED fiber whose closure captured a DOM element that
 *     is now detached. Its deps did not change when React replaced the node,
 *     so the cleanup keeps the old subtree for as long as the component lives.
 * (b) A Map / Set / plain-object registry whose entries are React values of
 *     UNMOUNTED components: a scope instance or DOM node whose
 *     `__reactFiber$…` fiber is not in the mounted tree, or such a fiber.
 *
 * "Mounted" = reachable from a `FiberRootNode.current` through `child` /
 * `sibling`, or the `alternate` of such a fiber (React points a host node's
 * `__reactFiber$` at either copy). Roots are found by shape
 * (`containerInfo` + `current`), so a minified build works too.
 */

export interface FiberIndex {
  roots: IHeapNode[];
  /** Roots whose `containerInfo` is itself detached DOM. */
  detachedRoots: number;
  /** Ids of every object with the fiber shape. */
  fibers: number[];
  mounted: Set<number>;
  /** Fibers reached through child/sibling (the current trees). */
  current: number;
  /** Object or DOM node id -> its `__reactFiber$` target id. */
  holderFiber: Map<number, number>;
}

/** The mounted fibers under `roots`: current trees plus their alternates. */
export function mountedFiberIds(roots: IHeapNode[]): {
  mounted: Set<number>;
  current: number;
} {
  const mounted = new Set<number>();
  const current = new Set<number>();
  const stack: IHeapNode[] = [];
  for (const root of roots) {
    const c = edgeTo(root, 'current');
    if (c?.type === 'object') stack.push(c);
  }
  while (stack.length > 0) {
    const f = stack.pop() as IHeapNode;
    if (current.has(f.id)) continue;
    current.add(f.id);
    mounted.add(f.id);
    // The alternate is mounted, but its child/sibling may still point at
    // fibers of a previous render, so it is not walked.
    const alt = edgeTo(f, 'alternate');
    if (alt?.type === 'object') mounted.add(alt.id);
    for (const k of ['child', 'sibling']) {
      const next = edgeTo(f, k);
      if (next?.type === 'object' && !current.has(next.id)) stack.push(next);
    }
  }
  return {mounted, current: current.size};
}

/** One pass over the heap: fiber roots, fiber-shaped objects, `__reactFiber$` holders. */
export function indexFibers(snapshot: IHeapSnapshot): FiberIndex {
  const roots: IHeapNode[] = [];
  const fibers: number[] = [];
  const holderFiber = new Map<number, number>();
  snapshot.nodes.forEach(node => {
    if (node.type !== 'object' && node.type !== 'native') return;
    let bits = 0;
    for (const e of node.references) {
      if (e.type !== 'property') continue;
      const k = e.name_or_index;
      if (typeof k !== 'string') continue;
      if (k === 'containerInfo') bits |= 1;
      else if (k === 'current') bits |= 2;
      else if (k === 'elementType') bits |= 4;
      else if (k === 'memoizedProps') bits |= 8;
      else if (k === 'return') bits |= 16;
      else if (k.startsWith('__reactFiber$'))
        holderFiber.set(node.id, e.toNode.id);
    }
    if ((bits & 3) === 3 && node.type === 'object') roots.push(node);
    if ((bits & 28) === 28) fibers.push(node.id);
  });
  const {mounted, current} = mountedFiberIds(roots);
  let detachedRoots = 0;
  for (const r of roots) {
    const c = edgeTo(r, 'containerInfo');
    if (c != null && isDetachedDOMNode(c)) detachedRoots++;
  }
  return {roots, detachedRoots, fibers, mounted, current, holderFiber};
}

/** Cleanup closures in a fiber's `updateQueue.lastEffect` ring. */
export function effectDestroys(
  fiber: IHeapNode,
  cap = 1000,
): Array<{effect: IHeapNode; destroy: IHeapNode}> {
  const out: Array<{effect: IHeapNode; destroy: IHeapNode}> = [];
  const queue = edgeTo(fiber, 'updateQueue');
  if (queue?.type !== 'object') return out;
  const seen = new Set<number>();
  let effect = edgeTo(queue, 'lastEffect');
  while (effect?.type === 'object' && !seen.has(effect.id) && seen.size < cap) {
    seen.add(effect.id);
    const inst = edgeTo(effect, 'inst');
    const destroy =
      inst?.type === 'object'
        ? edgeTo(inst, 'destroy')
        : edgeTo(effect, 'destroy');
    if (destroy?.type === 'closure') out.push({effect, destroy});
    effect = edgeTo(effect, 'next');
  }
  return out;
}

const isContextNode = (n: IHeapNode | null): n is IHeapNode =>
  n != null && n.name.startsWith('system / Context');

export type CapturedHit = {
  context: IHeapNode;
  variable: string;
  target: IHeapNode;
};

/**
 * Detached DOM elements held as variables in a closure's own scope and the
 * scope around it (the hook's render scope). Module scope is not searched:
 * a module variable is not specific to one cleanup. A closure's `context` is
 * the scope it was created in, so when the effect callback captures nothing
 * the climb starts at the hook's scope and its `previous` is the module's.
 * The module scope is the context whose `previous` is not a function Context
 * (the NativeContext or a ScriptContext), and the climb stops there.
 */
export function capturedDetached(
  closure: IHeapNode,
  maxDepth = 2,
): CapturedHit[] {
  const out: CapturedHit[] = [];
  let ctx = edgeTo(closure, 'context');
  for (let depth = 0; depth < maxDepth && isContextNode(ctx); depth++) {
    const previous = edgeTo(ctx, 'previous');
    if (!isContextNode(previous)) break;
    for (const e of ctx.references) {
      const t = e.toNode;
      if (
        e.type === 'context' &&
        isDetachedDOMNode(t) &&
        isDetachedElementName(t.name)
      ) {
        out.push({context: ctx, variable: String(e.name_or_index), target: t});
      }
    }
    ctx = previous;
  }
  return out;
}

/**
 * The function a context belongs to, from its ScopeInfo: V8 lists the
 * context-allocated names, then the function name, then the outer ScopeInfo.
 * Empty (an arrow or anonymous function) gives null.
 */
export function scopeFunctionName(ctx: IHeapNode): string | null {
  const info = edgeTo(ctx, 'scope_info');
  if (info == null) return null;
  const vars = new Set<string>();
  for (const e of ctx.references) {
    if (e.type === 'context') vars.add(String(e.name_or_index));
  }
  let best: {idx: number; name: string} | null = null;
  for (const e of info.references) {
    const idx = Number(e.name_or_index);
    if (!Number.isInteger(idx) || e.toNode.type !== 'string') continue;
    if (best == null || idx > best.idx) best = {idx, name: e.toNode.name};
  }
  return best != null && best.name !== '' && !vars.has(best.name)
    ? best.name
    : null;
}

function contextVars(ctx: IHeapNode, max = 4): string {
  const names: string[] = [];
  for (const e of ctx.references) {
    if (e.type === 'context') names.push(String(e.name_or_index));
  }
  const more = names.length > max ? `, +${names.length - max}` : '';
  return `{${names.slice(0, max).join(', ')}${more}}`;
}

export interface CleanupRow {
  component: string;
  variable: string;
  contexts: IHeapNode[];
  targets: IHeapNode[];
  fibers: Set<number>;
  retained: number;
  /** Bytes of targets whose immediate dominator is the holding context. */
  soleFreed: number;
  sole: number;
  chain: string;
  /** First cleanup closure, for `memlab_source_for_node`. */
  closure: number;
}

export interface EntryRow {
  collection: IHeapNode;
  kind: string;
  total: number;
  staleValues: IHeapNode[];
  freed: number;
  sampleKeys: string[];
  sampleFiber: number | null;
}

export interface StaleReactScan {
  index: FiberIndex;
  effects: number;
  cleanups: CleanupRow[];
  entries: EntryRow[];
  /** Candidate holders skipped because they are themselves held by dead state. */
  deadHolders: number;
  ms: number;
}

const keyLabel = (n: IHeapNode | null): string => {
  if (n == null) return 'smi';
  if (n.type === 'string' || n.type.endsWith(' string')) {
    const s = flattenString(n, 40).value;
    return JSON.stringify(s.length > 32 ? `${s.slice(0, 32)}…` : s);
  }
  return `${n.name || n.type}@${n.id}`;
};

/** Is `node` (transitively) dominated by something dead? Bounded climb. */
function deadOwned(node: IHeapNode, stale: Set<number>): boolean {
  let cur = node.dominatorNode;
  for (let i = 0; cur != null && cur.id > 3 && i < 100; i++) {
    if (stale.has(cur.id) || isDetachedDOMNode(cur)) return true;
    cur = cur.dominatorNode;
  }
  return false;
}

export function scanReactStaleRefs(snapshot: IHeapSnapshot): StaleReactScan {
  const t0 = Date.now();
  const index = indexFibers(snapshot);
  const {mounted} = index;
  if (index.roots.length === 0) {
    // No mounted tree to compare against: every fiber would read as stale.
    return {
      index,
      effects: 0,
      cleanups: [],
      entries: [],
      deadHolders: 0,
      ms: Date.now() - t0,
    };
  }

  // (a) Effect cleanups on mounted fibers.
  let effects = 0;
  const seenHit = new Set<string>();
  const seenEffect = new Set<number>();
  const byKey = new Map<string, CleanupRow>();
  for (const fid of mounted) {
    const fiber = snapshot.getNodeById(fid);
    if (fiber == null) continue;
    for (const {effect, destroy} of effectDestroys(fiber)) {
      if (seenEffect.has(effect.id)) continue;
      seenEffect.add(effect.id);
      effects++;
      for (const hit of capturedDetached(destroy)) {
        // Both copies of a fiber can share an effect: count a context once.
        const k = `${hit.context.id}:${hit.variable}`;
        if (seenHit.has(k)) continue;
        seenHit.add(k);
        const component = componentLabel(snapshot, fiber);
        const chain = describeChain(
          snapshot,
          edgeTo(destroy, 'context') ?? hit.context,
        );
        // The chain keeps two hooks apart that a minified build gives the
        // same component and variable names.
        const key = `${component}\u0000${hit.variable}\u0000${chain}`;
        let row = byKey.get(key);
        if (row == null) {
          row = {
            component,
            variable: hit.variable,
            contexts: [],
            targets: [],
            fibers: new Set(),
            retained: 0,
            soleFreed: 0,
            sole: 0,
            chain,
            closure: destroy.id,
          };
          byKey.set(key, row);
        }
        row.contexts.push(hit.context);
        row.fibers.add(fid);
        if (!row.targets.some(t => t.id === hit.target.id)) {
          row.targets.push(hit.target);
          row.retained += hit.target.retainedSize;
          if (hit.target.dominatorNode?.id === hit.context.id) {
            row.sole++;
            row.soleFreed += hit.target.retainedSize;
          }
        }
      }
    }
  }

  // (b) Registries of unmounted React values.
  const stale = new Set<number>();
  for (const [holder, fiber] of index.holderFiber) {
    if (!mounted.has(fiber)) stale.add(holder);
  }
  for (const f of index.fibers) if (!mounted.has(f)) stale.add(f);
  const candidates = new Map<number, IHeapNode>();
  const objectHits = new Map<number, number>();
  for (const id of stale) {
    const v = snapshot.getNodeById(id);
    if (v == null) continue;
    for (const e of v.referrers) {
      const from = e.fromNode;
      if (e.type === 'internal' && from.type === 'array') {
        for (const up of from.referrers) {
          const c = up.fromNode;
          if (
            up.name_or_index === 'table' &&
            (c.name === 'Map' || c.name === 'Set')
          ) {
            candidates.set(c.id, c);
          }
        }
      } else if (
        e.type === 'property' &&
        from.type === 'object' &&
        from.name === 'Object' &&
        !stale.has(from.id) &&
        !mounted.has(from.id)
      ) {
        const n = (objectHits.get(from.id) ?? 0) + 1;
        objectHits.set(from.id, n);
        if (n === 3) candidates.set(from.id, from);
      }
    }
  }
  const entries: EntryRow[] = [];
  let deadHolders = 0;
  for (const c of candidates.values()) {
    if (deadOwned(c, stale)) {
      deadHolders++;
      continue;
    }
    const row = entryRow(c, stale, index);
    if (row != null) entries.push(row);
  }

  return {
    index,
    effects,
    cleanups: [...byKey.values()].sort(
      (a, b) =>
        b.retained - a.retained || b.contexts.length - a.contexts.length,
    ),
    entries: entries.sort(
      (a, b) =>
        b.freed - a.freed || b.staleValues.length - a.staleValues.length,
    ),
    deadHolders,
    ms: Date.now() - t0,
  };
}

/** Component name; a minified one also names the module of its render function. */
function componentLabel(snapshot: IHeapSnapshot, fiber: IHeapNode): string {
  const name = fiberComponentName(fiber);
  if (name != null && name.length > 3) return name;
  const render = fiberRenderFunction(fiber);
  const rc = render != null ? edgeTo(render, 'context') : null;
  const mod = rc != null ? moduleOfScope(snapshot, rc) : null;
  return mod != null ? `${name ?? '?'} (${mod})` : (name ?? '(unnamed fiber)');
}

function describeChain(snapshot: IHeapSnapshot, ctx: IHeapNode): string {
  const parts = [`cleanup ${scopeFunctionName(ctx) ?? '(anonymous)'}`];
  const parent = edgeTo(ctx, 'previous');
  if (isContextNode(parent)) {
    const vars = contextVars(parent);
    const fn = scopeFunctionName(parent);
    if (vars !== '{}') parts.push(`${fn ?? '(scope)'} ${vars}`);
  }
  const mod = moduleOfScope(snapshot, ctx);
  if (mod != null) parts.push(`module ${mod}`);
  return parts.join(' ← ');
}

function entryRow(
  c: IHeapNode,
  stale: Set<number>,
  index: FiberIndex,
): EntryRow | null {
  const table =
    c.name === 'Map' || c.name === 'Set' ? edgeTo(c, 'table') : null;
  const ownedHere = (n: IHeapNode) => {
    const d = n.dominatorNode?.id;
    return d === c.id || (table != null && d === table.id);
  };
  let pairs: Array<{
    key: IHeapNode | null;
    value: IHeapNode | null;
    label?: string;
  }>;
  if (c.name === 'Map') pairs = enumerateMapEntries(c);
  else if (c.name === 'Set')
    pairs = enumerateSetElements(c).map(v => ({key: null, value: v}));
  else
    pairs = c.references
      .filter(e => e.type === 'property' && e.name_or_index !== '__proto__')
      .map(e => ({key: null, value: e.toNode, label: String(e.name_or_index)}));
  const staleValues: IHeapNode[] = [];
  const sampleKeys: string[] = [];
  const kinds = new Map<string, number>();
  let freed = 0;
  let sampleFiber: number | null = null;
  for (const p of pairs) {
    const hit = [p.value, p.key].find(n => n != null && stale.has(n.id));
    if (hit == null) continue;
    staleValues.push(hit);
    const viaFiber = index.holderFiber.get(hit.id);
    const kind =
      viaFiber == null
        ? 'fiber'
        : hit.type === 'native'
          ? 'DOM node'
          : 'object (`__reactFiber$`)';
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    if (sampleFiber == null && viaFiber != null) sampleFiber = viaFiber;
    for (const n of [p.key, p.value]) {
      if (n != null && ownedHere(n)) freed += n.retainedSize;
    }
    if (sampleKeys.length < 3) {
      const label =
        c.name === 'Map'
          ? keyLabel(p.key)
          : c.name === 'Set'
            ? `@${hit.id}`
            : (p.label ?? '');
      sampleKeys.push(label);
    }
  }
  if (staleValues.length === 0) return null;
  const kind = [...kinds.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)
    .join(' + ');
  return {
    collection: c,
    kind,
    total: pairs.length,
    staleValues,
    freed,
    sampleKeys,
    sampleFiber,
  };
}

const cell = (s: string, max = 90) => {
  const t = sanitizeForTable(s);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function cleanupTable(rows: CleanupRow[], cap: number): string {
  return markdownTable(
    [
      'Component',
      'Captured',
      'Contexts',
      'Detached retained',
      'Cut alone frees',
      'Scope chain',
      'Ids',
    ],
    rows
      .slice(0, cap)
      .map(r => [
        cell(r.component, 56),
        `\`${r.variable}\``,
        formatNumber(r.contexts.length),
        formatBytes(r.retained),
        r.sole === 0
          ? `0 B (co-held, 0/${r.targets.length} sole)`
          : `${formatBytes(r.soleFreed)} (${r.sole}/${r.targets.length} sole)`,
        cell(r.chain, 160),
        `cleanup @${r.closure}, ctx @${r.contexts[0].id} → ${r.targets[0].name.replace(/^Detached /, '')} @${r.targets[0].id}; fiber @${[...r.fibers][0]}`,
      ]),
    new Set([2, 3]),
  );
}

function entryTable(rows: EntryRow[], cap: number): string {
  return markdownTable(
    [
      'Holder',
      'Collection',
      'Unmounted / total',
      'Value',
      'Delete stale frees',
      'Sample keys',
      'Ids',
    ],
    rows
      .slice(0, cap)
      .map(r => [
        cell(heldByLabel(r.collection), 48),
        `${r.collection.name} @${r.collection.id}`,
        `${formatNumber(r.staleValues.length)} / ${formatNumber(r.total)}`,
        r.kind,
        formatBytes(r.freed),
        cell(r.sampleKeys.join(', '), 60),
        `value @${r.staleValues[0].id}` +
          (r.sampleFiber != null ? ` → fiber @${r.sampleFiber}` : ''),
      ]),
    new Set([2, 4]),
  );
}

/** A lead the sweep's residual call can cut (same fields as sweep's `Lead`). */
export interface StaleReactLead {
  label: string;
  bytes: number;
  section: number;
  ids: number[];
}

/**
 * Compact section for `memlab_sweep`. Empty when nothing is found (and on a
 * heap without React). Pass `leads` to collect cuttable leads: the holding
 * contexts for (a), the stale values for (b).
 */
const SWEEP_MIN_BYTES = 64 * 1024;

export function reactStaleRefsSweepSection(
  snapshot: IHeapSnapshot,
  opts: {cap?: number; section?: number; leads?: StaleReactLead[]} = {},
): string[] {
  const cap = opts.cap ?? 5;
  const scan = scanReactStaleRefs(snapshot);
  // Leads only: a 104-byte capture is real but not worth a sweep line.
  const cleanups = scan.cleanups.filter(r => r.retained >= SWEEP_MIN_BYTES);
  const entries = scan.entries.filter(
    r => r.freed >= SWEEP_MIN_BYTES || r.staleValues.length >= 10,
  );
  if (cleanups.length === 0 && entries.length === 0) return [];
  const sec = opts.section ?? 9;
  const lines = [
    `## ${sec}. React state holding dead UI → \`memlab_react_stale_refs\``,
    '',
  ];
  for (const r of cleanups.slice(0, cap)) {
    lines.push(
      `- ${formatNumber(r.contexts.length)} effect cleanups on mounted \`${r.component}\` capture detached DOM in \`${r.variable}\` (ctx @${r.contexts[0].id}): ${formatBytes(r.retained)} retained by those elements, cut alone frees ${formatBytes(r.soleFreed)}${r.sole === 0 ? ' (co-held)' : ''}; ${cell(r.chain, 120)}`,
    );
    opts.leads?.push({
      label: `${r.component} cleanup ${r.variable}`,
      bytes: r.retained,
      section: sec,
      ids: r.contexts.map(c => c.id),
    });
  }
  for (const r of entries.slice(0, cap)) {
    lines.push(
      `- ${r.collection.name} @${r.collection.id} \`${cell(heldByLabel(r.collection), 48)}\`: ${formatNumber(r.staleValues.length)} of ${formatNumber(r.total)} entries are ${r.kind} of unmounted components (keys ${cell(r.sampleKeys.join(', '), 60)}); deleting them frees ${formatBytes(r.freed)}`,
    );
    opts.leads?.push({
      label: `${heldByLabel(r.collection, 40)} unmounted entries`,
      bytes: r.freed,
      section: sec,
      ids: r.staleValues.map(v => v.id),
    });
  }
  lines.push('');
  return lines;
}

export function registerReactStaleRefs(server: McpServer): void {
  server.tool(
    'memlab_react_stale_refs',
    'Live React state that still points at dead UI, read from the fiber tree. (a) Effect cleanup closures (`effect.inst.destroy`, or `effect.destroy` in older React) on MOUNTED fibers whose scope captured a now-detached DOM element: the effect did not re-run when React replaced the node, so the cleanup pins the old subtree while the component stays mounted. Grouped by component and captured variable, with the enclosing hook scope and module. (b) Map / Set / plain-object registries whose entries are React scope instances, DOM nodes or fibers of UNMOUNTED components (their `__reactFiber$` fiber is not in the mounted tree), with stale/total counts and the bytes deleting those entries frees. "Mounted" = reachable from a FiberRootNode.current via child/sibling, or that fiber\'s alternate. Works minified. Prints nothing per section when nothing is found.',
    {
      limit: z
        .number()
        .optional()
        .default(10)
        .describe('Maximum rows per table (default 10).'),
    },
    async ({limit}) => {
      try {
        const snapshot = getSnapshot();
        const scan = scanReactStaleRefs(snapshot);
        const {index} = scan;
        if (index.roots.length === 0) {
          return toolResult(
            'No React fiber root (an object with `containerInfo` and `current`) in this snapshot, so there is no mounted tree to compare against. Nothing to report.',
          );
        }
        const lines = [
          '## React state holding dead UI',
          '',
          `- ${formatNumber(index.roots.length)} fiber root(s)${index.detachedRoots > 0 ? ` (${index.detachedRoots} with a DETACHED container: that whole tree is dead UI)` : ''}, ${formatNumber(index.fibers.length)} fibers: ${formatNumber(index.mounted.size)} mounted (${formatNumber(index.current)} current + alternates), ${formatNumber(index.fibers.filter(f => !index.mounted.has(f)).length)} retained but in no mounted tree.`,
          `- ${formatNumber(scan.effects)} effect cleanups walked in ${(scan.ms / 1000).toFixed(1)}s.`,
          '',
        ];
        const handle = getCurrentHandle();
        const next: string[] = [];
        if (scan.cleanups.length > 0) {
          lines.push(
            '### (a) Effect cleanups on mounted fibers capturing detached DOM',
            '',
            cleanupTable(scan.cleanups, limit),
            '',
            '_Detached retained = what those elements dominate (freed once nothing else holds them). Cut alone frees = the part whose only holder is that captured variable; "co-held" means another holder (often a detached-DOM owner from `memlab_detached_dom`) keeps the same trees, so fix both. A common cause: the effect reads `ref.current` into a local and its deps do not change when React replaces the node (fix: callback ref, or the element in the deps). Read the hook with `memlab_source_for_node` on the cleanup id._',
            '',
          );
          if (handle != null) {
            const name = 'react_stale_cleanups_1';
            setSavedResult(
              name,
              scan.cleanups[0].contexts.map(c => c.id),
              handle,
            );
            next.push(
              `- \`memlab_residual\` with \`{label: "${scan.cleanups[0].component} cleanup", from_result: "${name}"}\` added to its explained list (next to the other findings) — what cutting these ${scan.cleanups[0].contexts.length} contexts frees together with the other holders.`,
            );
          }
        }
        if (scan.entries.length > 0) {
          lines.push(
            '### (b) Registries holding values of unmounted components',
            '',
            entryTable(scan.entries, limit),
            '',
            "_Delete stale frees = retained size of the stale keys/values whose immediate dominator is the collection. A registry filled on mount and not deleted on unmount keeps one entry per unit ever mounted: check the module's unregister path, and confirm growth across two snapshots._",
            '',
          );
          next.push(
            `- \`memlab_map_entries({node_id: ${scan.entries[0].collection.id}})\` — read the entries.`,
          );
        }
        if (scan.cleanups.length === 0 && scan.entries.length === 0) {
          lines.push(
            'No effect cleanup on a mounted fiber captures detached DOM, and no Map/Set/object registry holds values of unmounted components.',
          );
        }
        if (scan.deadHolders > 0) {
          lines.push(
            `_${formatNumber(scan.deadHolders)} registry candidate(s) skipped: they are themselves owned by unmounted or detached state._`,
          );
        }
        if (next.length > 0) lines.push('', '**Next steps**', ...next);
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
