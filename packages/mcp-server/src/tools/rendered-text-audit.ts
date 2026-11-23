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
 * Rendered text that looks broken, read from React fibers in the heap.
 *
 * A heap snapshot holds every string the UI rendered, including rows below the
 * fold that no screenshot shows. A dropped parameter (`You added  & `), an
 * object rendered as `[object Object]`, or an unreplaced `{name}` placeholder
 * is a user-visible bug that leaves a recognizable string behind.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  edgeTo,
  elementTypeName,
  fiberComponentName,
  isFiberNode,
} from '../react-shapes.js';
import {ladderSegments, loadRunManifest} from '../run-manifest.js';
import {withSnapshotAt} from '../snapshot-borrow.js';
import {
  clampLabelTo,
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';
import {readArms} from './ab-compare.js';
import {resolveLadderPaths} from './ladder.js';

export interface TextRule {
  id: string;
  test: (text: string) => boolean;
}

export const TEXT_RULES: TextRule[] = [
  {id: '[object Object]', test: t => t.includes('[object Object]')},
  {
    id: 'undefined / null / NaN',
    test: t => /(^|[\s:(])(undefined|null|NaN)($|[\s.,)])/.test(t),
  },
  {id: 'Invalid Date', test: t => t.includes('Invalid Date')},
  {
    // An empty parameter leaves exactly two spaces, or a separator with
    // nothing on one side: `You added  & `, `, ,`, `Alice & `. A longer run
    // of spaces is typed content, not a dropped value.
    id: 'empty parameter',
    test: t =>
      /(?<! ) {2}(&|,|·|and\b|or\b)/.test(t) ||
      /(&|,|·) {2}(?! )/.test(t) ||
      /(^|\s)(&|·)\s*$/.test(t) ||
      /^\s*(&|,|·)\s/.test(t) ||
      /,\s*,/.test(t),
  },
  {
    id: 'unreplaced placeholder',
    test: t => /\{[A-Za-z_][\w]*\}/.test(t) || /(^|[^%])%[sd]\b/.test(t),
  },
];

const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];

function stringOf(node: IHeapNode | null): string | null {
  if (node == null || !node.isString) return null;
  return node.toStringNode()?.stringValue ?? node.name;
}

/** An element child's text: its single string child, else its subtree's. */
function elementText(fiber: IHeapNode): string {
  const props = edgeTo(fiber, 'memoizedProps');
  const single = props != null ? stringOf(edgeTo(props, 'children')) : null;
  return single ?? fiberSubtreeText(fiber, 100);
}

/**
 * What a host element shows: its single text child, or, with two or more text
 * fibers, its children's text joined, element children (`<b>Alice</b>`)
 * included.
 */
function hostText(fiber: IHeapNode): string | null {
  const props = edgeTo(fiber, 'memoizedProps');
  if (props == null) return null;
  const single = stringOf(edgeTo(props, 'children'));
  // A span holding only a separator (` · ` between a time and an icon) is
  // a separator, not a row that lost its values.
  if (single != null) return /^\s*[&,·]\s*$/.test(single) ? null : single;
  const kids: Array<[IHeapNode, string | null]> = [];
  let texts = 0;
  let child = edgeTo(fiber, 'child');
  for (let i = 0; child != null && i < 200; i++) {
    const t = stringOf(edgeTo(child, 'memoizedProps'));
    if (t != null) texts++;
    kids.push([child, t]);
    child = edgeTo(child, 'sibling');
  }
  if (texts < 2) return null;
  return kids.map(([c, t]) => t ?? elementText(c)).join('');
}

/**
 * What a component fiber's subtree renders, in document order: every text
 * fiber and every host element's single string child, joined as
 * `textContent` would (rows below the fold included). At most `maxFibers`
 * fibers are walked.
 */
export function fiberSubtreeText(fiber: IHeapNode, maxFibers = 500): string {
  const parts: string[] = [];
  const stack: IHeapNode[] = [];
  const first = edgeTo(fiber, 'child');
  if (first != null) stack.push(first);
  for (let seen = 0; stack.length > 0 && seen < maxFibers; seen++) {
    const f = stack.pop() as IHeapNode;
    const props = edgeTo(f, 'memoizedProps');
    // A text fiber's props ARE its string. Only a host element shows its
    // string `children`; a component passes them down to one.
    const type = edgeTo(f, 'type');
    const t =
      stringOf(props) ??
      (props != null && type != null && elementTypeName(type)?.startsWith('<')
        ? stringOf(edgeTo(props, 'children'))
        : null);
    if (t != null) parts.push(t);
    const sibling = edgeTo(f, 'sibling');
    if (sibling != null) stack.push(sibling);
    const child = edgeTo(f, 'child');
    if (child != null) stack.push(child);
  }
  return parts.join('');
}

/** The nearest composite component above a host fiber. */
function ownerComponent(fiber: IHeapNode): string {
  let cur = edgeTo(fiber, 'return');
  for (let i = 0; cur != null && i < 60; i++) {
    const name = fiberComponentName(cur);
    if (name != null && !name.startsWith('<')) return name;
    cur = edgeTo(cur, 'return');
  }
  return '(no component)';
}

export interface TextFinding {
  rule: string;
  owner: string;
  where: string;
  text: string;
  /** Host fibers showing it, a fiber and its alternate counted once. */
  count: number;
  sample: number;
}

export function renderedTextFindings(
  snapshot: IHeapSnapshot,
): Map<string, TextFinding> {
  const out = new Map<string, TextFinding>();
  // Per finding, the fiber pairs already counted.
  const pairsOf = new Map<string, Set<number>>();
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (node.type !== 'object' || !isFiberNode(node)) return;
    const type = edgeTo(node, 'type');
    const host = type != null ? elementTypeName(type) : null;
    if (host == null || !host.startsWith('<')) return;
    // A fiber and its alternate render the same text.
    const alt = edgeTo(node, 'alternate');
    const pairId = alt != null ? Math.min(alt.id, node.id) : node.id;
    const texts: Array<[string, string]> = [];
    const t = hostText(node);
    if (t != null) texts.push(['text', t]);
    const props = edgeTo(node, 'memoizedProps');
    if (props != null) {
      for (const a of ATTRS) {
        const v = stringOf(edgeTo(props, a));
        if (v != null) texts.push([a, v]);
      }
    }
    for (const [where, text] of texts) {
      for (const rule of TEXT_RULES) {
        if (!rule.test(text)) continue;
        const owner = ownerComponent(node);
        const key = `${rule.id}\u0000${owner}\u0000${where}\u0000${text}`;
        const f = out.get(key);
        const pairs = pairsOf.get(key);
        if (f == null || pairs == null) {
          out.set(key, {
            rule: rule.id,
            owner,
            where,
            text,
            count: 1,
            sample: node.id,
          });
          pairsOf.set(key, new Set([pairId]));
        } else if (!pairs.has(pairId)) {
          pairs.add(pairId);
          f.count++;
        }
      }
    }
  });
  return out;
}

const shown = (t: string): string =>
  `\`${clampLabelTo(t.replace(/`/g, "'").replace(/ /g, '·'), 70)}\``;

const NOTE =
  '_Text is shown with `·` for each space, so a dropped parameter is visible. Read from mounted and alternate fibers of host elements (their text children and `title` / `aria-label` / `placeholder` / `alt`), so rows below the fold count too. `memlab_get_node` on the sample shows the fiber._';

async function ladderLines(
  paths: string[],
  title: string,
  limit: number,
): Promise<string[]> {
  const perRung: Array<Map<string, TextFinding>> = [];
  for (const p of paths) {
    perRung.push(await withSnapshotAt(p, snap => renderedTextFindings(snap)));
  }
  const keys = new Set(perRung.flatMap(m => [...m.keys()]));
  const rows = [...keys]
    .map(k => {
      const f = perRung.map(m => m.get(k)).find(x => x != null) as TextFinding;
      return {f, series: perRung.map(m => m.get(k)?.count ?? 0)};
    })
    .sort(
      (a, b) =>
        b.series[b.series.length - 1] - a.series[a.series.length - 1] ||
        b.series.reduce((x, y) => x + y, 0) -
          a.series.reduce((x, y) => x + y, 0),
    )
    .slice(0, limit);
  if (rows.length === 0)
    return [title, '', 'No suspicious rendered text on any rung.'];
  return [
    title,
    '',
    markdownTable(
      [
        'Rule',
        'Component',
        'Where',
        'Text',
        ...paths.map((_, i) => `#${i + 1}`),
      ],
      rows.map(({f, series}) => [
        f.rule,
        f.owner,
        f.where,
        shown(f.text),
        ...series.map(formatNumber),
      ]),
      new Set(paths.map((_, i) => i + 4)),
    ),
  ];
}

export function registerRenderedTextAudit(server: McpServer): void {
  server.tool(
    'memlab_rendered_text_audit',
    'UI text bugs found in the heap, without pixels: React host elements whose rendered text or `title` / `aria-label` / `placeholder` / `alt` shows `[object Object]`, `undefined` / `null` / `NaN`, `Invalid Date`, an empty parameter (two spaces or a separator with nothing beside it: `You added  & `), or an unreplaced `{name}` / `%s` placeholder. Each finding names the nearest component and counts the host fibers showing it, rows below the fold included. With `run_dir` or `paths`, counts per rung; an A/B round is read per arm, so a fix that restores the text shows as the finding vanishing in the ON arm.',
    {
      run_dir: z.string().optional().describe('A leak-hunt round: every rung.'),
      paths: z
        .array(z.string())
        .optional()
        .describe('Ordered snapshot paths instead of run_dir.'),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(20)
        .describe('Findings to list (default 20).'),
    },
    async ({run_dir, paths, limit}) => {
      try {
        if (run_dir == null && (paths == null || paths.length === 0)) {
          const found = [...renderedTextFindings(getSnapshot()).values()]
            .sort((a, b) => b.count - a.count)
            .slice(0, limit);
          if (found.length === 0) {
            return toolResult(
              '## Rendered text audit\n\nNo suspicious rendered text in this snapshot.',
            );
          }
          return toolResult(
            [
              '## Rendered text audit',
              '',
              markdownTable(
                ['Rule', 'Component', 'Where', 'Text', 'Fibers', 'Sample'],
                found.map(f => [
                  f.rule,
                  f.owner,
                  f.where,
                  shown(f.text),
                  formatNumber(f.count),
                  `@${f.sample}`,
                ]),
                new Set([4]),
              ),
              '',
              NOTE,
            ].join('\n'),
          );
        }
        if (run_dir != null) {
          const manifest = loadRunManifest(run_dir);
          const segs = ladderSegments(manifest);
          if (segs.length > 1) {
            let arms: Array<{name: string; paths: string[]}> = [];
            let armsError: string | null = null;
            try {
              arms = readArms(run_dir);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              // A reload without an A/B section is not an error.
              if (!/has no `ab` section/.test(msg)) armsError = msg;
            }
            const out = [
              `## Rendered text audit: ${segs.length} isolate segments`,
              ...(armsError != null
                ? ['', `_Arms not labelled: ${armsError}_`]
                : []),
            ];
            // By file name: run.json may record a rung relative to the round
            // while the manifest resolves it.
            const base = (p: string) => p.replace(/^.*\//, '');
            for (const seg of segs) {
              const arm = arms.find(a =>
                a.paths.some(p => base(p) === base(seg.paths[0])),
              );
              out.push(
                '',
                ...(await ladderLines(
                  seg.paths,
                  `### Segment ${seg.index}${arm != null ? ` (${arm.name.toUpperCase()} arm)` : ''}: rungs ${seg.firstRung}-${seg.lastRung}`,
                  limit,
                )),
              );
            }
            out.push('', NOTE);
            return toolResult(out.join('\n'));
          }
          return toolResult(
            [
              ...(await ladderLines(
                manifest.paths,
                `## Rendered text audit across ${manifest.paths.length} rungs`,
                limit,
              )),
              '',
              NOTE,
            ].join('\n'),
          );
        }
        const files = resolveLadderPaths(paths as string[]).paths;
        return toolResult(
          [
            ...(await ladderLines(
              files,
              `## Rendered text audit across ${files.length} snapshots`,
              limit,
            )),
            '',
            NOTE,
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
