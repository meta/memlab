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
 * Model instances that share an identity value.
 *
 * Apps built on "one canonical model per id" (Backbone-style collections,
 * normalized stores) should hold one object per id. A second object with the
 * same id is a copy: a snapshot taken for a listener, a stale record a cache
 * kept after the store replaced it. Copies look like ordinary records to every
 * class count, so the only way to see them is to read each record's id and
 * group by it.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapEdge, IHeapNode, IHeapSnapshot} from '@memlab/core';
import memlabCore from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  armScanBudgetFor,
  resolveRungs,
  scaledTimeoutMs,
  withSnapshotAt,
} from '../snapshot-borrow.js';
import {rungPaths} from './eval-across.js';
import {selectPopulation} from './trace-all.js';
import {
  boundedDominatorRetainedSize,
  clampLabelTo,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

const {NumericSet} = memlabCore;

// Backing-store and closure plumbing: an edge with one of these names says
// nothing about who holds the record.
const PLUMBING = new Set(['properties', 'elements', 'table', 'context', 'map']);
const TAIL_HOPS = 4;

/** The value at `path` (property names, `.`-separated), or null. */
function identityOf(node: IHeapNode, path: string[]): string | null {
  let cur: IHeapNode = node;
  for (const seg of path) {
    let next: IHeapNode | null = null;
    for (const e of cur.references) {
      if (e.type === 'weak' || e.type === 'shortcut') continue;
      if (String(e.name_or_index) === seg) {
        next = e.toNode;
        break;
      }
    }
    if (next == null) return null;
    cur = next;
  }
  if (!cur.isString) return null;
  return cur.toStringNode()?.stringValue ?? cur.name;
}

function hopLabel(e: IHeapEdge): string | null {
  const name = String(e.name_or_index);
  if (e.type === 'element' || /^\d+$/.test(name)) return '[]';
  if (e.type !== 'context' && PLUMBING.has(name)) return null;
  return `.${name}`;
}

/**
 * The last few meaningful hops of the node's shortest retainer path, top-down:
 * what a reader needs to name the holder, and stable enough to group copies.
 */
function retainerTail(node: IHeapNode): string {
  const hops: string[] = [];
  let cur: IHeapNode = node;
  let truncated = false;
  for (let guard = 0; guard < 64; guard++) {
    const e = cur.pathEdge;
    if (e == null) break;
    const from = e.fromNode;
    if (from.type === 'synthetic') break;
    const label = hopLabel(e);
    if (label != null) {
      if (hops.length === TAIL_HOPS) {
        truncated = true;
        break;
      }
      hops.push(`${clampLabelTo(from.name, 40)}${label}`);
    }
    cur = from;
  }
  if (hops.length === 0) return '(no retainer path)';
  return `${truncated ? '… → ' : ''}${hops.reverse().join(' → ')}`;
}

export interface DuplicateReport {
  candidates: number;
  readable: number;
  /** Records whose identity is the empty string: not given an id yet, so not copies. */
  emptyIdentity: number;
  identities: number;
  duplicated: number;
  extras: number;
  extrasRetained: number;
  top: Array<{
    cls: string;
    identity: string;
    copies: number;
    oldest: number;
    newest: number;
  }>;
  /** Records per `class\u0000identity`, copied or not, for comparing rungs. */
  copiesByKey: Map<string, number>;
  /**
   * Identities carried by records of more than one class (a Contact, a Chat
   * and a Presence for the same user). One per type is normal for a
   * normalized store, so these are not copies.
   */
  crossType: {
    identities: number;
    combos: Array<{classes: string[]; identities: number; sample: string}>;
  };
  holders: Array<{
    tail: string;
    extras: number;
    retained: number;
    sample: number;
  }>;
}

export function modelDuplicates(
  snapshot: IHeapSnapshot,
  sel: {className?: string; shape?: string[]; path: string[]},
  limit: number,
): DuplicateReport {
  const candidates =
    sel.className != null || (sel.shape != null && sel.shape.length > 0)
      ? selectPopulation(snapshot, {className: sel.className, shape: sel.shape})
      : selectPopulation(snapshot, {shape: [sel.path[0]]});
  // Keyed on (class, identity): a Contact and a Chat with the same id are two
  // models of one entity, not a copy.
  const byIdentity = new Map<string, number[]>();
  const classesOf = new Map<string, Set<string>>();
  let readable = 0;
  let emptyIdentity = 0;
  for (const node of candidates) {
    if (node.type !== 'object') continue;
    const id = identityOf(node, sel.path);
    if (id == null) continue;
    if (id === '') {
      emptyIdentity++;
      continue;
    }
    readable++;
    const key = `${node.name}\u0000${id}`;
    const list = byIdentity.get(key);
    if (list == null) byIdentity.set(key, [node.id]);
    else list.push(node.id);
    const classes = classesOf.get(id);
    if (classes == null) classesOf.set(id, new Set([node.name]));
    else classes.add(node.name);
  }
  const combos = new Map<string, {classes: string[]; ids: string[]}>();
  for (const [id, classes] of classesOf) {
    if (classes.size < 2) continue;
    const sorted = [...classes].sort();
    const k = sorted.join('\u0000');
    const c = combos.get(k);
    if (c == null) combos.set(k, {classes: sorted, ids: [id]});
    else c.ids.push(id);
  }
  const crossType = {
    identities: [...combos.values()].reduce((n, c) => n + c.ids.length, 0),
    combos: [...combos.values()]
      .sort((a, b) => b.ids.length - a.ids.length)
      .slice(0, limit)
      .map(c => ({
        classes: c.classes,
        identities: c.ids.length,
        sample: c.ids[0],
      })),
  };
  const copiesByKey = new Map<string, number>();
  // V8 ids grow with allocation inside one isolate, so the lowest id is the
  // first record made for the identity: the canonical one, by assumption.
  const extras: number[] = [];
  const top: DuplicateReport['top'] = [];
  for (const [key, ids] of byIdentity) {
    copiesByKey.set(key, ids.length);
    if (ids.length < 2) continue;
    const cut = key.indexOf('\u0000');
    ids.sort((a, b) => a - b);
    extras.push(...ids.slice(1));
    top.push({
      cls: key.slice(0, cut),
      identity: key.slice(cut + 1),
      copies: ids.length,
      oldest: ids[0],
      newest: ids[ids.length - 1],
    });
  }
  top.sort(
    (a, b) => b.copies - a.copies || a.identity.localeCompare(b.identity),
  );
  const groups = new Map<string, number[]>();
  for (const id of extras) {
    const node = snapshot.getNodeById(id);
    if (node == null) continue;
    const tail = retainerTail(node);
    const g = groups.get(tail);
    if (g == null) groups.set(tail, [id]);
    else g.push(id);
  }
  const holders = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, limit)
    .map(([tail, ids]) => ({
      tail,
      extras: ids.length,
      retained: boundedDominatorRetainedSize(new NumericSet(ids), snapshot)
        .retained,
      sample: ids[ids.length - 1],
    }));
  return {
    candidates: candidates.length,
    readable,
    emptyIdentity,
    identities: classesOf.size,
    duplicated: top.length,
    extras: extras.length,
    extrasRetained:
      extras.length > 0
        ? boundedDominatorRetainedSize(new NumericSet(extras), snapshot)
            .retained
        : 0,
    top: top.slice(0, limit),
    copiesByKey,
    crossType,
    holders,
  };
}

function headline(r: DuplicateReport): string {
  return (
    `${formatNumber(r.candidates)} candidate(s), ${formatNumber(r.readable)} with a readable identity, ` +
    `${formatNumber(r.identities)} distinct. **${formatNumber(r.duplicated)} (class, identity) pair(s) have copies: ` +
    `${formatNumber(r.extras)} extra cop(ies) retaining ${formatBytes(r.extrasRetained)}.**` +
    (r.emptyIdentity > 0
      ? ` ${formatNumber(r.emptyIdentity)} record(s) with an empty identity are left out: a record not given an id yet is not a copy.`
      : '')
  );
}

/**
 * An identity as text a table can show. Invisible code points are escaped, so
 * two rows never look alike. So is the Private Use Area: V8's snapshot writer
 * keeps only the low 16 bits of a character outside the BMP (👍 U+1F44D is
 * written as U+F44D), which most fonts draw as nothing.
 */
export function showIdentity(id: string): string {
  return Array.from(id, c => {
    const n = c.charCodeAt(0);
    const invisible =
      n <= 0x1f ||
      (n >= 0x7f && n <= 0x9f) ||
      n === 0xad ||
      n === 0x34f ||
      n === 0x61c ||
      (n >= 0x115f && n <= 0x1160) ||
      (n >= 0x17b4 && n <= 0x17b5) ||
      n === 0x180e ||
      (n >= 0x200b && n <= 0x200f) ||
      (n >= 0x202a && n <= 0x202e) ||
      (n >= 0x2060 && n <= 0x206f) ||
      n === 0x3164 ||
      (n >= 0xe000 && n <= 0xf8ff) ||
      (n >= 0xfe00 && n <= 0xfe0f) ||
      n === 0xfeff ||
      n === 0xffa0;
    return invisible ? `\\u{${n.toString(16)}}` : c;
  }).join('');
}

function crossTypeLines(r: DuplicateReport): string[] {
  if (r.crossType.identities === 0) return [];
  return [
    '',
    `**Same id, different model types** (normal for a normalized store, so NOT counted as copies): ${formatNumber(r.crossType.identities)} identit(ies).`,
    '',
    markdownTable(
      ['Classes', 'Identities', 'Sample'],
      r.crossType.combos.map(c => [
        c.classes.map(x => `\`${clampLabelTo(x, 30)}\``).join(' + '),
        formatNumber(c.identities),
        `\`${clampLabelTo(showIdentity(c.sample), 40).replace(/`/g, "'")}\``,
      ]),
      new Set([1]),
    ),
  ];
}

function details(
  r: DuplicateReport,
  first: DuplicateReport | null = null,
): string[] {
  if (r.extras === 0) return [];
  return [
    '',
    '**Where the extra copies are held** (shortest retainer path, last hops):',
    '',
    markdownTable(
      ['Held via', 'Extra copies', 'Retained', 'Sample'],
      r.holders.map(h => [
        h.tail,
        formatNumber(h.extras),
        formatBytes(h.retained),
        `@${h.sample}`,
      ]),
      new Set([1, 2]),
    ),
    '',
    '**Most-copied identities:**',
    '',
    markdownTable(
      [
        'Class',
        'Identity',
        ...(first != null ? ['Copies at first rung'] : []),
        'Copies',
        'Oldest',
        'Newest',
      ],
      r.top.map(t => [
        `\`${clampLabelTo(t.cls, 30)}\``,
        `\`${clampLabelTo(showIdentity(t.identity), 60).replace(/`/g, "'")}\``,
        ...(first != null
          ? [
              formatNumber(
                first.copiesByKey.get(`${t.cls}\u0000${t.identity}`) ?? 0,
              ),
            ]
          : []),
        formatNumber(t.copies),
        `@${t.oldest}`,
        `@${t.newest}`,
      ]),
      new Set(first != null ? [2, 3] : [2]),
    ),
    ...(first != null
      ? [
          '',
          '_A count the same at the first rung is a standing structure (one object per membership, say), not a copy made per cycle._',
        ]
      : []),
  ];
}

const NOTE =
  '_Copies are counted per (class, identity). The oldest copy (lowest node id; ids grow with allocation in one isolate) is taken as canonical and the rest count as extras. `memlab_retainer_trace` on a sample gives the full path._';

export function registerModelDuplicates(server: McpServer): void {
  server.tool(
    'memlab_model_duplicates',
    'Model instances of the same class that share an identity value (e.g. a message id at `__x_id._serialized`): copies of what should be one canonical record per id, which no class count can see. Records of different classes with the same id (a Contact and a Chat for one user) are listed separately as cross-type sharing, not as copies. Reports how many (class, identity) pairs have copies, the extra copies and their retained size, where the extras are held (the last hops of their shortest retainer path, grouped), and the most-copied identities. With `run_dir` or `paths`, the same counts at every rung with the change since the first, and the first-rung copy count of each top identity, so a copy count that grows per cycle stands out from a standing one.',
    {
      identity_path: z
        .string()
        .min(1)
        .describe(
          'Property path from a record to its identity string, `.`-separated (e.g. `__x_id._serialized`, `id`).',
        ),
      class: z
        .string()
        .optional()
        .describe(
          'Only records of this class. Without `class` or `shape`, every object with the first property of `identity_path` is a candidate.',
        ),
      shape: z
        .array(z.string())
        .optional()
        .describe(
          'Only records carrying all of these properties (works on minified builds).',
        ),
      run_dir: z
        .string()
        .optional()
        .describe('A leak-hunt round: measure the rungs of its ladder.'),
      rungs: z
        .array(z.number().int())
        .optional()
        .describe(
          'With `run_dir`, which rungs (0-based; negative counts from the end). Default: all.',
        ),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Snapshot files to measure in order, instead of the active snapshot.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(10)
        .describe('Rows per table (default 10).'),
    },
    async ({
      identity_path,
      class: className,
      shape,
      run_dir,
      rungs,
      paths,
      limit,
    }) => {
      try {
        const sel = {
          className,
          shape,
          path: identity_path.split('.').filter(s => s !== ''),
        };
        if (sel.path.length === 0) {
          return errorResult(
            new Error(
              '`identity_path` names no property: pass a dotted path such as "id" or "id._serialized".',
            ),
          );
        }
        const what = `${className != null ? `\`${className}\`` : shape != null && shape.length > 0 ? `shape {${shape.join(', ')}}` : 'records'} by \`${identity_path}\``;
        const files =
          run_dir != null && run_dir !== ''
            ? rungPaths(run_dir, rungs)
            : (paths ?? []);
        if (files.length === 0) {
          const r = modelDuplicates(getSnapshot(), sel, limit);
          if (r.readable === 0) {
            return toolResult(
              `No ${what}: ${formatNumber(r.candidates)} candidate(s), none with a string at \`${identity_path}\`. Check the path with \`memlab_object_shape\` on one record.`,
            );
          }
          return toolResult(
            [
              `## Model duplicates — ${what}`,
              '',
              headline(r),
              ...details(r),
              ...crossTypeLines(r),
              '',
              NOTE,
            ].join('\n'),
          );
        }

        const {rungs: resolved, largestMB} = resolveRungs(files);
        const rows: string[][] = [];
        let first: DuplicateReport | null = null;
        let last: DuplicateReport | null = null;
        for (const rung of resolved) {
          armScanBudgetFor(scaledTimeoutMs(largestMB));
          const r = await withSnapshotAt(rung.localPath, snap =>
            modelDuplicates(snap, sel, limit),
          );
          first ??= r;
          rows.push([
            rung.label,
            formatNumber(r.readable),
            formatNumber(r.identities),
            formatNumber(r.duplicated),
            formatNumber(r.extras),
            `${r.extras - first.extras >= 0 ? '+' : ''}${formatNumber(r.extras - first.extras)}`,
            formatBytes(r.extrasRetained),
          ]);
          last = r;
        }
        return toolResult(
          [
            `## Model duplicates per rung — ${what}`,
            '',
            markdownTable(
              [
                'Rung',
                'Records',
                'Identities',
                'With copies',
                'Extra copies',
                'Δ extras vs first',
                'Extras retain',
              ],
              rows,
              new Set([1, 2, 3, 4, 5, 6]),
            ),
            ...(last != null && last.extras > 0
              ? [
                  '',
                  `### Last rung`,
                  ...details(last, resolved.length > 1 ? first : null),
                ]
              : []),
            ...(last != null ? crossTypeLines(last) : []),
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
