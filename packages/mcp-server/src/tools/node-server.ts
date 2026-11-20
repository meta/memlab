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
import {oddballValue} from '../react-shapes.js';
import {
  clampLabelTo,
  flattenString,
  errorResult,
  formatBytes,
  formatNumber,
  heldByLabel,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * Node.js server state the generic tools do not name: extra `vm` realms,
 * module-scope state held by `require.cache`, and request-era objects
 * (finished requests, AsyncLocalStorage stores copied into long-lived handles).
 *
 * Agents without memlab found all three on a Next.js server heap with
 * hand-written scripts: one vm realm per served route (~139 KB each), Next's
 * startup-only zod config schema at `require.cache['…/config-schema.js']
 * .exports` (1.0 MB), and a pooled database socket plus 60 s intervals
 * carrying the stores of the request that created them.
 *
 * A tool of its own rather than a `memlab_native_contexts` section: the
 * require.cache and request state matter on single-realm heaps too, and the
 * realm split keeps its per-realm output contract.
 */

const NATIVE_CONTEXT_RE = /^(Detached )?system \/ NativeContext( \/ |$)/;
/** A require.cache key: an absolute POSIX or Windows path, or a file URL. */
const MODULE_KEY_RE = /^(\/|[A-Za-z]:[\\/]|file:)/;
const STORE_EDGE = '<symbol kResourceStore>';
const FRAME_EDGE = '<symbol kAsyncContextFrame>';

export interface CacheEntry {
  key: string;
  module: IHeapNode;
  exports: IHeapNode | null;
  retained: number;
}

export interface StoreHolder {
  node: IHeapNode;
  slots: number;
  routes: string[];
  example: number;
}

export interface NodeServerFacts {
  realmCount: number;
  realmRetained: number;
  cache: CacheEntry[];
  /** Per class: instance count and lifecycle flag counts. */
  census: Map<string, {total: number; flags: Map<string, number>}>;
  requests: Array<{req: IHeapNode; res: IHeapNode | null}>;
  holders: StoreHolder[];
  promiseHolders: number;
}

function prop(node: IHeapNode, name: string): IHeapNode | null {
  for (const e of node.references) {
    if (String(e.name_or_index) === name) return e.toNode;
  }
  return null;
}

const isTrue = (n: IHeapNode | null) => n != null && oddballValue(n) === 'true';
const isOddball = (n: IHeapNode | null) => n == null || oddballValue(n) != null;

function stringProp(node: IHeapNode, name: string): string | null {
  const t = prop(node, name);
  if (t == null || !t.isString) return null;
  // A sliced string reads as its whole parent; mark it approximate.
  const {value, approximate} = flattenString(t, 200);
  return approximate ? `≈ ${value}` : value;
}

/**
 * Lifecycle flags per class. An instance is recognised by a field the class
 * prototype does not carry, so `Socket.prototype` and friends are not counted.
 */
const CENSUS: Record<
  string,
  {marker: string; flags: Record<string, (n: IHeapNode) => boolean>}
> = {
  IncomingMessage: {
    marker: 'complete',
    flags: {
      complete: n => isTrue(prop(n, 'complete')),
      aborted: n => isTrue(prop(n, 'aborted')),
    },
  },
  ServerResponse: {
    marker: 'finished',
    flags: {
      finished: n => isTrue(prop(n, 'finished')),
      destroyed: n => isTrue(prop(n, 'destroyed')),
    },
  },
  Socket: {
    marker: 'connecting',
    flags: {
      'handle closed': n => {
        const h = prop(n, '<symbol kHandle>') ?? prop(n, '_handle');
        return h != null && oddballValue(h) === 'null';
      },
    },
  },
  Timeout: {
    marker: '_idleTimeout',
    flags: {
      destroyed: n => isTrue(prop(n, '_destroyed')),
      repeating: n => !isOddball(prop(n, '_repeat')),
    },
  },
};

/** `…/next/dist/server/config-schema.js`: the part after the last node_modules, else the last 3 segments. */
export function cacheKeyLabel(key: string): string {
  const nm = key.lastIndexOf('node_modules/');
  if (nm >= 0) return `…/${key.slice(nm + 'node_modules/'.length)}`;
  const parts = key.split(/[\\/]/);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : key;
}

const requestBytes = (r: {req: IHeapNode; res: IHeapNode | null}) =>
  r.req.retainedSize + (r.res?.retainedSize ?? 0);

const factsCache = new WeakMap<IHeapSnapshot, NodeServerFacts>();

/** One pass over the nodes (plus each candidate's own edges). */
export function nodeServerFacts(snapshot: IHeapSnapshot): NodeServerFacts {
  const hit = factsCache.get(snapshot);
  if (hit != null) return hit;
  const facts: NodeServerFacts = {
    realmCount: 0,
    realmRetained: 0,
    cache: [],
    census: new Map(),
    requests: [],
    holders: [],
    promiseHolders: 0,
  };
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (NATIVE_CONTEXT_RE.test(node.name)) {
      facts.realmCount++;
      facts.realmRetained += node.retainedSize;
      return;
    }
    if (node.type !== 'object' || node.id <= 3) return;
    const name = node.name;
    if (name === 'Module') {
      for (const e of node.referrers) {
        const key = String(e.name_or_index);
        if (e.type !== 'property' || !MODULE_KEY_RE.test(key)) continue;
        if (e.fromNode.type !== 'object') continue;
        const ex = prop(node, 'exports');
        const exports = ex != null && !isOddball(ex) ? ex : null;
        facts.cache.push({
          key,
          module: node,
          exports,
          retained: exports?.retainedSize ?? 0,
        });
        break;
      }
      return;
    }
    const spec = CENSUS[name];
    if (spec != null && prop(node, spec.marker) != null) {
      let row = facts.census.get(name);
      if (row == null) {
        row = {total: 0, flags: new Map()};
        facts.census.set(name, row);
      }
      row.total++;
      for (const [flag, test] of Object.entries(spec.flags)) {
        if (test(node)) row.flags.set(flag, (row.flags.get(flag) ?? 0) + 1);
      }
      if (name === 'IncomingMessage' && isTrue(prop(node, 'complete'))) {
        facts.requests.push({req: node, res: null});
      }
    }
    let slots = 0;
    let example = 0;
    const routes = new Set<string>();
    for (const e of node.references) {
      const edge = String(e.name_or_index);
      if (edge !== STORE_EDGE && edge !== FRAME_EDGE) continue;
      const store = e.toNode;
      if (isOddball(store)) continue;
      slots++;
      const route = stringProp(store, 'route') ?? stringProp(store, 'page');
      // Prefer a store that names its route as the example to drill into.
      if (route != null && routes.size === 0) example = store.id;
      else if (example === 0) example = store.id;
      if (route != null) routes.add(route);
    }
    if (slots === 0) return;
    if (name === 'Promise') facts.promiseHolders++;
    else facts.holders.push({node, slots, routes: [...routes], example});
  });
  facts.cache.sort((a, b) => b.retained - a.retained);
  // Pair each finished request with its response (`res.req === req`).
  for (const r of facts.requests) {
    for (const e of r.req.referrers) {
      if (String(e.name_or_index) !== 'req') continue;
      if (e.fromNode.name === 'ServerResponse') r.res = e.fromNode;
    }
  }
  facts.requests.sort((a, b) => requestBytes(b) - requestBytes(a));
  facts.holders.sort((a, b) => b.node.retainedSize - a.node.retainedSize);
  factsCache.set(snapshot, facts);
  return facts;
}

function censusLine(facts: NodeServerFacts): string {
  return Object.keys(CENSUS)
    .map(cls => {
      const row = facts.census.get(cls);
      if (row == null) return `${cls} 0`;
      const flags = Object.keys(CENSUS[cls].flags)
        .map(f => `${f} ${formatNumber(row.flags.get(f) ?? 0)}`)
        .join(', ');
      return `${cls} ${formatNumber(row.total)} (${flags})`;
    })
    .join(' · ');
}

function realmLine(facts: NodeServerFacts): string {
  return `**${formatNumber(facts.realmCount)} realms (NativeContexts), ${formatBytes(facts.realmRetained)}** retained by them → \`memlab_native_contexts\``;
}

/**
 * Lines for `memlab_quick_diagnosis` on a Node.js heap; none on any other.
 */
export function nodeServerFlagLines(
  snapshot: IHeapSnapshot,
  env: string,
): string[] {
  if (env !== 'node') return [];
  const facts = nodeServerFacts(snapshot);
  const lines: string[] = [];
  if (facts.realmCount > 1) lines.push(`- ${realmLine(facts)}`);
  const top = facts.cache.filter(c => c.retained > 0).slice(0, 3);
  if (top.length > 0) {
    const named = top
      .map(c => `\`${cacheKeyLabel(c.key)}\` ${formatBytes(c.retained)}`)
      .join(', ');
    lines.push(
      `- require.cache: ${formatNumber(facts.cache.length)} modules; largest exports ${named} → \`memlab_node_server\``,
    );
  }
  if (facts.requests.length > 0 || facts.holders.length > 0) {
    lines.push(
      `- ${formatNumber(facts.requests.length)} completed request(s) still reachable; ${formatNumber(facts.holders.length)} non-Promise object(s) carry AsyncLocalStorage stores → \`memlab_node_server\``,
    );
  }
  return lines.length > 0 ? ['## Node.js server', '', ...lines, ''] : [];
}

/** Findings for `memlab_check_health` on a Node.js heap; none on any other. */
export function nodeServerFindings(
  snapshot: IHeapSnapshot,
  env: string,
): Array<{
  severity: 'info';
  title: string;
  detail: string;
  next_step: string;
}> {
  if (env !== 'node') return [];
  const facts = nodeServerFacts(snapshot);
  if (facts.realmCount <= 1) return [];
  return [
    {
      severity: 'info',
      title: `${formatNumber(facts.realmCount)} realms (NativeContexts) in a Node.js heap, ${formatBytes(facts.realmRetained)} retained by them`,
      detail:
        'Each extra realm is a `vm` context (vm.createContext / runInNewContext). Anything created inside one keeps the whole realm alive; when the count tracks routes or evaluated files, it grows with traffic.',
      next_step:
        'memlab_native_contexts for bytes per realm, then memlab_node_server for require.cache owners and request state',
    },
  ];
}

export function registerNodeServer(server: McpServer): void {
  server.tool(
    'memlab_node_server',
    'Node.js server state in one call: the realm (NativeContext) count, `require.cache` entries ranked by what their `exports` retain (module-scope state such as a startup-only config schema), a census of IncomingMessage / ServerResponse / Socket / Timeout with lifecycle flags, the completed requests still reachable, and the objects carrying AsyncLocalStorage stores (`<symbol kResourceStore>`) with the routes those stores belong to. ' +
      'Node copies the current store into every async resource it creates, so a socket or interval first opened inside a request keeps that request alive for its own lifetime.',
    {
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(10)
        .describe('Rows per table (default 10).'),
    },
    async ({limit}) => {
      try {
        const snapshot = getSnapshot();
        const started = Date.now();
        const facts = nodeServerFacts(snapshot);
        const cache = facts.cache.filter(c => c.retained > 0);
        if (
          cache.length === 0 &&
          facts.census.size === 0 &&
          facts.holders.length === 0 &&
          facts.promiseHolders === 0
        ) {
          return toolResult(
            `No Node.js server state found: no require.cache entries, HTTP/socket/timer objects or AsyncLocalStorage stores. ${formatNumber(facts.realmCount)} realm(s): \`memlab_native_contexts\`.`,
          );
        }
        const lines: string[] = ['# Node.js server state', ''];
        if (facts.realmCount > 1) lines.push(realmLine(facts), '');

        if (cache.length > 0) {
          const total = cache.reduce((s, c) => s + c.retained, 0);
          lines.push(
            `## require.cache: ${formatNumber(facts.cache.length)} modules, exports retain ${formatBytes(total)} in total`,
            '',
            markdownTable(
              [
                '#',
                'Entry',
                'Module',
                'exports',
                'Retained',
                'exports held by',
              ],
              cache
                .slice(0, limit)
                .map((c, i) => [
                  String(i + 1),
                  `require.cache['${clampLabelTo(cacheKeyLabel(c.key), 70)}'].exports`,
                  `@${c.module.id}`,
                  `${c.exports?.name || c.exports?.type} @${c.exports?.id}`,
                  formatBytes(c.retained),
                  heldByLabel(c.exports as IHeapNode, 40),
                ]),
              new Set([4]),
            ),
            '',
            '_Retained = what the exports object alone keeps alive. A module needed only at startup (config validation, CLI parsing) still holds this while it stays in require.cache and in the closures that imported it._',
            '',
          );
        }

        if (facts.census.size > 0) {
          lines.push('## Requests, sockets, timers', '', censusLine(facts), '');
        }
        if (facts.requests.length > 0) {
          lines.push(
            markdownTable(
              ['Completed request', 'ServerResponse', 'Retained', 'Held by'],
              facts.requests
                .slice(0, limit)
                .map(({req, res}) => [
                  `@${req.id} ${stringProp(req, 'method') ?? ''} ${clampLabelTo(stringProp(req, 'url') ?? '?', 50)}`,
                  res == null
                    ? '-'
                    : `@${res.id}${isTrue(prop(res, 'finished')) ? ' finished' : ''}`,
                  formatBytes(requestBytes({req, res})),
                  heldByLabel(req, 40),
                ]),
              new Set([2]),
            ),
            '',
          );
        }

        if (facts.holders.length > 0 || facts.promiseHolders > 0) {
          lines.push(
            `## AsyncLocalStorage stores carried by ${formatNumber(facts.holders.length)} object(s) (\`${STORE_EDGE}\`)`,
            '',
          );
        }
        if (facts.holders.length > 0) {
          lines.push(
            markdownTable(
              [
                'Holder',
                'State',
                'Stores',
                'Routes',
                'e.g.',
                'Retained',
                'Held by',
              ],
              facts.holders.slice(0, limit).map(h => {
                const n = h.node;
                const state =
                  n.name === 'Timeout'
                    ? isTrue(prop(n, '_destroyed'))
                      ? 'destroyed'
                      : !isOddball(prop(n, '_repeat'))
                        ? 'repeating'
                        : 'pending'
                    : '';
                return [
                  `${n.name} @${n.id}`,
                  state,
                  formatNumber(h.slots),
                  clampLabelTo(h.routes.join(', ') || '-', 50),
                  `@${h.example}`,
                  formatBytes(n.retainedSize),
                  heldByLabel(n, 40),
                ];
              }),
              new Set([2, 5]),
            ),
            '',
          );
        }
        if (facts.promiseHolders > 0) {
          lines.push(
            `${formatNumber(facts.promiseHolders)} Promise(s) carry stores too (not listed).`,
            '',
          );
        }
        lines.push(
          `_Next: \`memlab_retainer_trace\` on a store or exports id to see its path. (${((Date.now() - started) / 1000).toFixed(1)} s)_`,
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
