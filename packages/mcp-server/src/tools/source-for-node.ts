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
import {sourceOfNode} from './module-attribution.js';
import {escapeRegExp, findModuleSpans, scriptSources} from './module-source.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/** Nodes whose definition is printed, at most, per call. */
const MAX_SOURCE_NODES = 5;
/** A line longer than this is minified: print a character window instead. */
const MINIFIED_LINE = 400;

/** The closure to read a definition for: the node, or one closing over it. */
function closureFor(snapshot: IHeapSnapshot, id: number): IHeapNode | null {
  const node = snapshot.getNodeById(id);
  if (node == null) return null;
  if (node.type === 'closure') return node;
  let best: IHeapNode | null = null;
  node.forEachReferrer(edge => {
    const from = edge.fromNode;
    if (edge.name_or_index !== 'context' || from.type !== 'closure') return;
    // The longest name is the least likely to be a mangled one.
    if (best == null || from.name.length > best.name.length) best = from;
  });
  return best;
}

/** Variable names a context holds, and the closures over it. */
function contextSummary(node: IHeapNode): string | null {
  if (!node.name.startsWith('system / Context')) return null;
  const vars: string[] = [];
  node.forEachReference(edge => {
    if (edge.type === 'context') vars.push(String(edge.name_or_index));
  });
  const fns = new Set<string>();
  node.forEachReferrer(edge => {
    if (edge.name_or_index === 'context' && edge.fromNode.type === 'closure') {
      fns.add(edge.fromNode.name || '(anonymous)');
    }
  });
  const list = (xs: string[]) =>
    xs.length > 20
      ? `${xs.slice(0, 20).join(', ')}, … (${xs.length})`
      : xs.join(', ');
  return (
    `Context variables: ${vars.length > 0 ? list(vars) : '(none)'}. ` +
    `Closures over it: ${fns.size > 0 ? list([...fns].sort()) : '(none)'}.`
  );
}

/** Where `name` is defined in `text`: a declaration, an assignment or a method. */
function definitionRe(name: string): RegExp {
  const n = escapeRegExp(name);
  return new RegExp(
    `\\bfunction(?:\\s*\\*\\s*|\\s+)${n}\\s*\\(|(?<![\\w$.])${n}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\([^()]*\\)\\s*=>|[\\w$]+\\s*=>)|(?<![\\w$.])${n}\\s*\\([^()]*\\)\\s*\\{`,
    'g',
  );
}

/** `around` lines either side of `index`, or a character window on a minified line. */
function excerpt(text: string, index: number, around: number): string {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const lineEnd = text.indexOf('\n', index);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  if (line.length > MINIFIED_LINE) {
    const width = Math.max(200, around * 40);
    const from = Math.max(0, index - width);
    const to = Math.min(text.length, index + width);
    return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ')}${to < text.length ? '…' : ''}`;
  }
  let from = lineStart;
  for (let i = 0; i < around && from > 0; i++) {
    from = text.lastIndexOf('\n', from - 2) + 1;
  }
  let to = lineEnd < 0 ? text.length : lineEnd;
  for (let i = 0; i < around && to < text.length; i++) {
    const next = text.indexOf('\n', to + 1);
    to = next < 0 ? text.length : next;
  }
  return text
    .slice(from, to)
    .split('\n')
    .map(l => (l.length > MINIFIED_LINE ? `${l.slice(0, MINIFIED_LINE)}…` : l))
    .join('\n');
}

function definitionSection(
  snapshot: IHeapSnapshot,
  id: number,
  module: string | null,
  around: number,
  sources: () => ReturnType<typeof scriptSources>,
  spansOf: (module: string) => ReturnType<typeof findModuleSpans>,
): string[] {
  const node = snapshot.getNodeById(id);
  if (node == null) return [];
  const out: string[] = [`### @${id} ${node.name.slice(0, 60)}`, ''];
  const ctx = contextSummary(node);
  if (ctx != null) out.push(ctx, '');
  const closure = closureFor(snapshot, id);
  if (closure == null || closure.name === '') {
    out.push('_No named closure to look up in the source._', '');
    return out;
  }
  // A compiler-renamed callback (`onClick__useCallback_$0`) is also tried by
  // the name it was written under.
  const names = [closure.name, closure.name.replace(/__\w+_\$\d+$/, '')].filter(
    (n, i, a) => n !== '' && a.indexOf(n) === i,
  );
  const texts =
    module != null
      ? spansOf(module).map(s => ({where: `\`${module}\``, text: s.text}))
      : sources().map(s => ({
          where: `\`${s.url.replace(/\?.*$/, '').slice(-60)}\``,
          text: s.text,
        }));
  for (const name of names) {
    const re = definitionRe(name);
    let first: {where: string; text: string; index: number} | null = null;
    let count = 0;
    for (const t of texts) {
      re.lastIndex = 0;
      for (let m = re.exec(t.text); m != null; m = re.exec(t.text)) {
        count++;
        first ??= {where: t.where, text: t.text, index: m.index};
      }
    }
    if (first == null) continue;
    out.push(
      `\`${name}\`${closure.id !== id ? ` (closure @${closure.id})` : ''} defined in ${first.where}` +
        (count > 1
          ? ` — first of ${formatNumber(count)} definitions of that name${name.length <= 2 ? ' (a minified name; the module scopes the search)' : ''}`
          : '') +
        ':',
      '',
      '```js',
      excerpt(first.text, first.index, around),
      '```',
      '',
    );
    return out;
  }
  out.push(
    `_No definition of \`${closure.name}\` found in ${module != null ? `\`${module}\`` : 'the script sources'}${texts.length === 0 ? ' (the snapshot holds no source for it)' : ''}._`,
    '',
  );
  return out;
}

export function registerSourceForNode(server: McpServer): void {
  server.tool(
    'memlab_source_for_node',
    'Which MODULE\'s code a node belongs to — the step from "which object" to "which file" without a code-search round trip. A closure is resolved through its context chain to the module scope its Haste factory created (exact, via ScopeInfo); any other node is first walked up its retainer path to the nearest closure or context. Also returns the bundle script URL and, when the snapshot has one, the source location (usually absent on bundled builds, which is why the module is read structurally).',
    {
      node_ids: z
        .array(z.number())
        .min(1)
        .describe('Node ids to resolve (closures, contexts, or any object).'),
      max_hops: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .default(40)
        .describe(
          'Retainer hops to walk up from a non-code node (default 40).',
        ),
      context_lines: z
        .number()
        .int()
        .min(0)
        .max(50)
        .optional()
        .describe(
          `Also print each node's function definition from the source the snapshot holds: the closure itself, or for a context the closure over it, found by name inside its module. This many lines either side (a minified line gets a character window instead). A context also lists its variables and closures. First ${MAX_SOURCE_NODES} nodes only.`,
        ),
    },
    async ({node_ids, max_hops, context_lines}) => {
      try {
        const snapshot = getSnapshot();
        const modules = new Map<number, string | null>();
        const rows = node_ids.map(id => {
          const node = snapshot.getNodeById(id);
          if (node == null) return [`@${id}`, '(not found)', '—', '—', '—'];
          let src: ReturnType<typeof sourceOfNode>;
          try {
            src = sourceOfNode(snapshot, node, max_hops);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return [
              `@${id} ${node.name.slice(0, 40)}`,
              `(error: ${msg.slice(0, 80)})`,
              '—',
              '—',
              '—',
            ];
          }
          modules.set(id, src.module);
          return [
            `@${id} ${node.name.slice(0, 40)}`,
            src.module ?? '(no module found)',
            src.via != null
              ? `${src.via.name.slice(0, 40)} @${src.via.id}${src.hops > 0 ? ` (${src.hops} hop(s) up)` : ''}`
              : '—',
            src.location != null
              ? `${src.location.line}:${src.location.column}`
              : '—',
            src.script != null
              ? src.script.replace(/\?.*$/, '').slice(-60)
              : '—',
          ];
        });
        return toolResult(
          [
            '## Source module per node',
            '',
            markdownTable(
              ['Node', 'Module', 'Read from', 'Line:col', 'Script'],
              rows,
            ),
            '',
            '_`Read from` is the closure or context whose scope chain named the module. A closure defined at a bundle\'s top level, outside any module factory, has no module scope and reads "(no module found)"._',
            ...(context_lines != null
              ? (() => {
                  let all: ReturnType<typeof scriptSources> | null = null;
                  const sources = () => (all ??= scriptSources(snapshot));
                  const spanCache = new Map<
                    string,
                    ReturnType<typeof findModuleSpans>
                  >();
                  // A module scope is named `Foo_react` for `__d("Foo.react", …)`.
                  const spansOf = (module: string) => {
                    let spans = spanCache.get(module);
                    if (spans == null) {
                      spans = findModuleSpans(snapshot, module);
                      if (spans.length === 0 && module.includes('_')) {
                        spans = findModuleSpans(
                          snapshot,
                          module.replace(/_([^_]+)$/, '.$1'),
                        );
                      }
                      spanCache.set(module, spans);
                    }
                    return spans;
                  };
                  return [
                    '',
                    ...node_ids
                      .slice(0, MAX_SOURCE_NODES)
                      .flatMap(id =>
                        definitionSection(
                          snapshot,
                          id,
                          modules.get(id) ?? null,
                          context_lines,
                          sources,
                          spansOf,
                        ),
                      ),
                  ];
                })()
              : []),
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
