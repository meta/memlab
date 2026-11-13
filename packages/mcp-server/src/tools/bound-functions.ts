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
import {sourceOfNode} from './module-attribution.js';
import {edgeTo, fiberComponentName, isFiberNode} from '../react-shapes.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * Bound functions (`fn.bind(...)`), grouped by what they are bound to.
 *
 * V8 names every bound function `native_bind`, so a class census shows one
 * opaque row (+3.3/cycle on a real round) and nothing says whose they are.
 * The edges do: `bound_function` is the target, `bound_this` the receiver,
 * `bound_argument_N` the bound arguments. A React `useState` setter is
 * `dispatchSetState.bind(null, fiber, queue)`, so its first argument names
 * the component that owns the state.
 */

export interface BoundGroup {
  key: string;
  target: string;
  module: string | null;
  receiver: string;
  holder: string;
  count: number;
}

function label(
  node: IHeapNode | null,
  moduleOf: (n: IHeapNode) => string | null,
): string {
  if (node == null) return '—';
  if (isFiberNode(node)) {
    return `fiber <${fiberComponentName(node) ?? '?'}>`;
  }
  if (node.type === 'closure') {
    // A function receiver (`Function.prototype.toString.bind(fn)`, a method
    // bound to its own function) is named by its module where it has one.
    const m = moduleOf(node);
    return `${node.name || '(anonymous)'}()${m != null ? ` @${m}` : ''}`;
  }
  return node.name !== '' ? node.name : `(${node.type})`;
}

function firstStrongReferrer(node: IHeapNode) {
  for (const e of node.referrers) {
    if (e.type === 'weak' || e.type === 'shortcut') continue;
    return e;
  }
  return null;
}

/**
 * The first strong referrer edge, as `<holder>.<edge>`. An internal holder
 * (`system / PropertyArray`, an elements store) is climbed once to the
 * object that owns it, which is the name a reader can search for.
 */
function holderOf(node: IHeapNode): string {
  const e = firstStrongReferrer(node);
  if (e == null) return '(none)';
  let from = e.fromNode;
  let edge = e.type === 'element' ? '[]' : String(e.name_or_index);
  if (
    from.name.startsWith('system / PropertyArray') ||
    from.name === '(object elements)'
  ) {
    const up = firstStrongReferrer(from);
    if (up != null) {
      from = up.fromNode;
      edge = `(slot ${edge})`;
    }
  }
  const name = from.name.startsWith('system / Context')
    ? 'context'
    : from.name || `(${from.type})`;
  return `${name.slice(0, 40)}.${edge.slice(0, 40)}`;
}

export function countBoundFunctions(
  snapshot: IHeapSnapshot,
): Map<string, BoundGroup> {
  const groups = new Map<string, BoundGroup>();
  const modules = new Map<number, string | null>();
  const moduleOf = (n: IHeapNode): string | null => {
    if (!modules.has(n.id)) {
      modules.set(n.id, sourceOfNode(snapshot, n, 0).module);
    }
    return modules.get(n.id) ?? null;
  };
  snapshot.nodes.forEach(node => {
    if (node.type !== 'closure' || node.name !== 'native_bind') return;
    const target = edgeTo(node, 'bound_function');
    const receiver = edgeTo(node, 'bound_this');
    const arg0 = edgeTo(node, 'bound_argument_0');
    const module = target != null ? moduleOf(target) : null;
    const dispatcher = arg0 != null && isFiberNode(arg0);
    const targetName = dispatcher
      ? 'setState dispatcher'
      : target?.name || '(anonymous)';
    const recv = dispatcher
      ? label(arg0, moduleOf)
      : receiver != null && receiver.type !== 'hidden'
        ? label(receiver, moduleOf)
        : arg0 != null
          ? `arg0 ${label(arg0, moduleOf)}`
          : '—';
    const holder = holderOf(node);
    const key = `${targetName}\u0000${module ?? ''}\u0000${recv}\u0000${holder}`;
    const g = groups.get(key);
    if (g != null) {
      g.count++;
    } else {
      groups.set(key, {
        key,
        target: targetName,
        module,
        receiver: recv,
        holder,
        count: 1,
      });
    }
  });
  return groups;
}

function row(g: BoundGroup): string[] {
  return [
    `\`${g.target.slice(0, 50)}\``,
    g.module ?? '—',
    `\`${g.receiver.slice(0, 50)}\``,
    `\`${g.holder}\``,
  ];
}

export function registerBoundFunctions(server: McpServer): void {
  server.tool(
    'memlab_bound_functions',
    'Bound functions (`fn.bind(...)`, all named `native_bind` by V8) grouped by what they are bound to: the target function and its module, the receiver or first bound argument (for a React `useState` setter, the component that owns the state), and the edge holding them. ' +
      'A class census shows bound functions as one opaque `native_bind` row; this says whose they are. With `run_dir` (or `paths`) it counts every rung and ranks the groups by growth per cycle; without, it reads the loaded snapshot.',
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
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(15)
        .describe('Groups to show.'),
    },
    async ({run_dir, paths, limit}) => {
      try {
        if (run_dir == null && (paths == null || paths.length === 0)) {
          const groups = [...countBoundFunctions(getSnapshot()).values()].sort(
            (a, b) => b.count - a.count,
          );
          const total = groups.reduce((a, g) => a + g.count, 0);
          return toolResult(
            [
              `## Bound functions: ${formatNumber(total)} in ${formatNumber(groups.length)} group(s)`,
              '',
              markdownTable(
                [
                  'Target',
                  'Module',
                  'Receiver / first arg',
                  'Held by',
                  'Count',
                ],
                groups
                  .slice(0, limit)
                  .map(g => [...row(g), formatNumber(g.count)]),
                new Set([4]),
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
        const perRung: Array<Map<string, BoundGroup>> = [];
        for (const p of rungPaths) {
          perRung.push(
            await withSnapshotAt(p, snap => countBoundFunctions(snap)),
          );
        }
        if (axis != null && axis.length !== perRung.length) axis = null;
        const xs = axis ?? perRung.map((_, i) => i);
        const unit = axis != null ? 'cycle' : 'rung';
        const all = new Map<string, BoundGroup>();
        for (const m of perRung) for (const [k, g] of m) all.set(k, g);
        const ranked = [...all.values()]
          .map(g => {
            const ys = perRung.map(m => m.get(g.key)?.count ?? 0);
            return {g, ys, slope: linearFit(xs, ys).slope};
          })
          .sort(
            (a, b) =>
              b.slope - a.slope ||
              b.ys[b.ys.length - 1] - a.ys[a.ys.length - 1],
          );
        const totals = perRung.map(m =>
          [...m.values()].reduce((a, g) => a + g.count, 0),
        );
        const lines = [
          `## Bound functions across the ladder`,
          '',
          `Total \`native_bind\`: ${totals.map(formatNumber).join(' → ')} (${linearFit(xs, totals).slope >= 0 ? '+' : ''}${linearFit(xs, totals).slope.toFixed(2)}/${unit}).`,
          '',
          markdownTable(
            [
              'Target',
              'Module',
              'Receiver / first arg',
              'Held by',
              'Series',
              `Δ/${unit}`,
            ],
            ranked
              .slice(0, limit)
              .map(r => [
                ...row(r.g),
                r.ys.map(formatNumber).join(' → '),
                `${r.slope >= 0 ? '+' : ''}${r.slope.toFixed(3)}`,
              ]),
          ),
          '',
          '_A growing group is a `.bind(...)` per cycle that is never released. For a `setState dispatcher` row the receiver column names the component; check it with `memlab_react_update_queues`. For a listener row (`Held by` an EventListener or a subscription list), look for the matching remove call._',
        ];
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
