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
import {getSnapshot} from '../heap-state.js';
import {withSnapshotAt} from '../snapshot-borrow.js';
import {loadRunManifest} from '../run-manifest.js';
import {resolveLadderPaths} from './ladder.js';
import {linearFit} from './ladder-probe.js';
import {moduleCollections} from './cache-inventory.js';
import {moduleRecords} from '../module-registry.js';
import {
  enumerateMapEntries,
  enumerateSetElements,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * What module-level caches alone keep alive.
 *
 * A cache keyed by a model holds that model after the app has let it go, and
 * size-ranked cache tools cannot tell that apart from a cache of live data:
 * both are "a big Map". Reachability can. See `soleRetained`.
 */

/**
 * Maps and Sets wrapped by a memoizer object on an exported function:
 * `fn.$$cache` is often an LRU object whose Map sits one or two properties
 * down (`$$cache.$1.$2`), which a direct collection scan does not see.
 */
function wrappedFunctionCaches(
  snapshot: IHeapSnapshot,
): Array<{module: string; name: string; key: string; node: IHeapNode}> {
  const found = new Map<
    number,
    {module: string; holders: string[]; node: IHeapNode}
  >();
  const descend = (
    module: string,
    path: string,
    node: IHeapNode,
    depth: number,
  ): void => {
    for (const e of node.references) {
      if (e.type !== 'property') continue;
      const prop = String(e.name_or_index);
      if (
        prop === '__proto__' ||
        prop === 'prototype' ||
        prop === 'constructor'
      )
        continue;
      const t = e.toNode;
      if (t.type !== 'object') continue;
      const here = `${path}.${prop}`;
      if (t.name === 'Map' || t.name === 'Set') {
        const row = found.get(t.id);
        if (row == null) found.set(t.id, {module, holders: [here], node: t});
        else if (row.holders.length < 100) row.holders.push(here);
      } else if (depth < 3) {
        descend(module, here, t, depth + 1);
      }
    }
  };
  for (const rec of moduleRecords(snapshot).values()) {
    const root = rec.exports;
    if (root == null) continue;
    for (const e of root.references) {
      if (e.type !== 'property' || e.toNode.type !== 'closure') continue;
      const fn = e.toNode;
      for (const fe of fn.references) {
        if (fe.type !== 'property') continue;
        const prop = String(fe.name_or_index);
        if (prop === 'prototype' || prop === '__proto__') continue;
        const t = fe.toNode;
        // A direct collection is listed by moduleCollections already.
        if (t.type !== 'object' || t.name === 'Map' || t.name === 'Set')
          continue;
        descend(rec.name, `${String(e.name_or_index)}.${prop}`, t, 1);
      }
    }
  }
  return [...found.values()].map(f => {
    const first = [...f.holders].sort()[0];
    // `getter.$$cache.$1.$2` -> stable as `$$cache.$1.$2` when shared.
    const tail = first.slice(first.indexOf('.') + 1);
    return {
      module: f.module,
      name:
        f.holders.length > 1
          ? `${tail} (shared by ${formatNumber(f.holders.length)} functions)`
          : first,
      key: `${f.module}\u0000${tail}`,
      node: f.node,
    };
  });
}

export interface SoleRow {
  key: string;
  module: string;
  holder: string;
  kind: string;
  /** Objects reachable only through this cache (and possibly other caches). */
  objects: number;
  selfBytes: number;
  classes: Map<string, number>;
}

/** Classes that are structure, not what a cache keeps. */
const SKIP_CLASS = /^(system \/|\(|Array$|Object$|$)/;

/**
 * What the app's module-level caches alone keep alive.
 *
 * Reachability from the GC roots is computed twice: once as is, once refusing
 * to traverse any cache collection. An object reached the first way and not
 * the second is held ONLY through caches — the app let it go. Each cache is
 * then walked to attribute those objects to it. Dominators cannot answer this:
 * a discarded model held by two caches at once (one round's attachments were)
 * is dominated by neither.
 */
export function soleRetained(
  snapshot: IHeapSnapshot,
  minEntries: number,
): Map<string, SoleRow> {
  const direct = moduleCollections(snapshot);
  const ids = new Set(direct.map(c => c.node.id));
  const caches = [
    ...direct,
    ...wrappedFunctionCaches(snapshot).filter(c => !ids.has(c.node.id)),
  ].filter(c => c.node.name !== 'WeakMap' && countOf(c.node) >= minEntries);
  const cacheIds = new Set(caches.map(c => c.node.id));
  const without = new Uint8Array(snapshot.nodes.length);
  const stack: IHeapNode[] = [];
  snapshot.nodes.forEach(node => {
    if (node.type !== 'synthetic' && node.id > 3) return;
    without[node.nodeIndex] = 1;
    stack.push(node);
  });
  while (stack.length > 0) {
    const node = stack.pop() as IHeapNode;
    for (const e of node.references) {
      if (e.type === 'weak') continue;
      const to = e.toNode;
      if (without[to.nodeIndex] === 1) continue;
      without[to.nodeIndex] = 1;
      // Reached, but not traversed: what lies past it is cache-held.
      if (!cacheIds.has(to.id)) stack.push(to);
    }
  }
  const rows = new Map<string, SoleRow>();
  for (const c of caches) {
    const row: SoleRow = {
      key: c.key,
      module: c.module,
      holder: c.name,
      kind: c.node.name,
      objects: 0,
      selfBytes: 0,
      classes: new Map(),
    };
    const seen = new Set<number>([c.node.id]);
    const walk: IHeapNode[] = [c.node];
    while (walk.length > 0 && seen.size < 2_000_000) {
      const node = walk.pop() as IHeapNode;
      for (const e of node.references) {
        if (e.type === 'weak') continue;
        const to = e.toNode;
        if (without[to.nodeIndex] === 1 || seen.has(to.id)) continue;
        seen.add(to.id);
        walk.push(to);
        row.objects++;
        row.selfBytes += to.self_size;
        if (!SKIP_CLASS.test(to.name) && !to.isString) {
          row.classes.set(to.name, (row.classes.get(to.name) ?? 0) + 1);
        }
      }
    }
    if (row.objects > 0) rows.set(row.key, row);
  }
  return rows;
}

function countOf(node: IHeapNode): number {
  if (node.name === 'Map') return enumerateMapEntries(node).length;
  if (node.name === 'Set') return enumerateSetElements(node).length;
  let n = 0;
  for (const e of node.references) if (e.type === 'element') n++;
  return n;
}

function topClasses(m: Map<string, number> | undefined): string {
  if (m == null) return '—';
  return [...m]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, n]) => `${k} ${formatNumber(n)}`)
    .join(', ');
}

export function registerCacheSoleRetainer(server: McpServer): void {
  server.tool(
    'memlab_cache_sole_retainer',
    "Module-level caches (Map / Set / Array held by a module scope or by an exported function, such as a memoizer's `fn.$$cache`) counted by the objects that ONLY caches keep alive: reachability from the GC roots is computed with every cache collection refused, and what is lost is attributed to the caches that reach it. The app has let those objects go. " +
      'Size-ranked cache tools cannot tell this from a cache of live data. With `run_dir` (or `paths`) it ranks caches by cache-only objects gained per cycle, with the classes they hold; without, it lists the loaded snapshot.',
    {
      run_dir: z
        .string()
        .optional()
        .describe('A leak-hunt run directory: count every rung.'),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Ordered snapshot paths, oldest first (or ["ladder:<name>"]), instead of run_dir.',
        ),
      min_entries: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(1)
        .describe('Skip collections with fewer entries than this.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(15)
        .describe('Rows to show.'),
    },
    async ({run_dir, paths, min_entries, limit}) => {
      try {
        if (run_dir == null && (paths == null || paths.length === 0)) {
          const rows = [...soleRetained(getSnapshot(), min_entries).values()]
            .sort((a, b) => b.selfBytes - a.selfBytes)
            .slice(0, limit);
          if (rows.length === 0) {
            return toolResult(
              'No module-level cache keeps anything alive that only caches reach.',
            );
          }
          return toolResult(
            [
              '## What only caches keep alive',
              '',
              markdownTable(
                [
                  'Module',
                  'Holder',
                  'Kind',
                  'Cache-only objects',
                  'Self',
                  'Holding',
                ],
                rows.map(r => [
                  r.module,
                  `\`${r.holder}\``,
                  r.kind,
                  formatNumber(r.objects),
                  formatBytes(r.selfBytes),
                  topClasses(r.classes),
                ]),
                new Set([3, 4]),
              ),
            ].join('\n'),
          );
        }
        let rungPaths: string[];
        let axis: number[] | null = null;
        if (run_dir != null) {
          const manifest = loadRunManifest(run_dir);
          rungPaths = manifest.paths;
          axis = manifest.cyclesPerRung;
        } else {
          rungPaths = resolveLadderPaths(paths as string[]).paths;
        }
        if (rungPaths.length < 2) {
          return errorResult(
            new Error('Need at least two rungs to rank growth.'),
          );
        }
        const perRung: Array<Map<string, SoleRow>> = [];
        for (const p of rungPaths) {
          perRung.push(
            await withSnapshotAt(p, snap => soleRetained(snap, min_entries)),
          );
        }
        if (axis != null && axis.length !== perRung.length) axis = null;
        const xs = axis ?? perRung.map((_, i) => i);
        const unit = axis != null ? 'cycle' : 'rung';
        const keys = new Set<string>();
        for (const m of perRung) for (const k of m.keys()) keys.add(k);
        const ranked = [...keys]
          .map(k => {
            const ys = perRung.map(m => m.get(k)?.objects ?? 0);
            const last = [...perRung]
              .reverse()
              .find(m => m.has(k))
              ?.get(k);
            return {k, ys, last, slope: linearFit(xs, ys).slope};
          })
          .sort((a, b) => b.slope - a.slope)
          .slice(0, limit);
        const growing = ranked.filter(r => r.slope > 0.5);
        return toolResult(
          [
            '## What only caches keep alive, across the ladder',
            '',
            markdownTable(
              [
                'Module',
                'Holder',
                'Cache-only objects',
                `Δ/${unit}`,
                'Self (last)',
                'Holding (last)',
              ],
              ranked.map(r => [
                r.last?.module ?? '—',
                `\`${r.last?.holder ?? '?'}\``,
                r.ys.map(formatNumber).join(' → '),
                `${r.slope >= 0 ? '+' : ''}${r.slope.toFixed(3)}`,
                r.last != null ? formatBytes(r.last.selfBytes) : '—',
                topClasses(r.last?.classes),
              ]),
            ),
            '',
            growing.length > 0
              ? `**${growing.length} cache(s) keep more objects alive every ${unit} that nothing but caches reaches.** The app dropped them; evict the entry where the object is discarded (or key the cache weakly). An object held by two caches counts under both.`
              : '_No cache gains cache-only objects across the ladder._',
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
