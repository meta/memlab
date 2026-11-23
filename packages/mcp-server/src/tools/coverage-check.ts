/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import fs from 'fs';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {allLeads, type RecordedLead} from '../lead-registry.js';
import {
  errorResult,
  formatBytes,
  markdownTable,
  sanitizeForTable,
  toolResult,
} from '../utils.js';

/** One finding or not_problem of a draft report. */
export interface DraftItem {
  kind: 'finding' | 'not_problem';
  label: string;
  text: string;
}

// "Ignored" counts only as the whole heading, so a finding titled
// "F2 abort signal ignored on unmount" stays a finding.
const NP_HEADING =
  /not[\s_-]*(a[\s_-]*)?problems?|ruled[\s_-]*out|non-issues|^[\W_]*ignored([\W_]+(leads?|items?))?[\W\d_]*$/i;

/** report.json (`findings`, `not_problems`), else markdown split by heading. */
export function parseDraft(raw: string): DraftItem[] {
  try {
    const j = JSON.parse(raw) as {findings?: unknown; not_problems?: unknown};
    const list = (v: unknown, kind: DraftItem['kind']): DraftItem[] =>
      (Array.isArray(v) ? v : []).map((f, i) => ({
        kind,
        label:
          kind === 'finding'
            ? String((f as {id?: unknown})?.id ?? `F${i + 1}`)
            : `NP${i + 1}`,
        text: JSON.stringify(f),
      }));
    if (Array.isArray(j.findings) || Array.isArray(j.not_problems)) {
      return [
        ...list(j.findings, 'finding'),
        ...list(j.not_problems, 'not_problem'),
      ];
    }
  } catch {
    // Not JSON: markdown or plain text.
  }
  const items: DraftItem[] = [];
  let np: number | null = null; // heading level of a not-problems section
  for (const line of raw.split('\n')) {
    const h = /^(#{1,6})\s+(.*)/.exec(line);
    if (h != null && np != null && h[1].length <= np) np = null;
    if (h != null && np == null && NP_HEADING.test(h[2])) np = h[1].length;
    const kind = np != null ? 'not_problem' : 'finding';
    const bullet = np != null && /^\s{0,3}([-*]|\d+\.)\s/.test(line);
    if (items.length === 0 || h != null || bullet) {
      const n = items.filter(x => x.kind === kind).length + 1;
      items.push({
        kind,
        label: `${kind === 'finding' ? '§' : 'NP'}${n}`,
        text: '',
      });
    }
    items[items.length - 1].text += `${line}\n`;
  }
  return items.filter(x => x.text.trim() !== '');
}

const STOP = new Set(
  (
    'object array map set weakmap closure var system context anonymous string ' +
    'strings native internal hidden elements properties window global module ' +
    'prototype entry root code number value values key keys default exports ' +
    'next return length data function promise error symbol element document ' +
    'detached record records sweep internalnode'
  ).split(' '),
);

/**
 * The names a report would use: strong ones (camelCase, `_x`/`$x`,
 * Capitalized, long) match alone, two plain words match together.
 */
export function terms(text: string): {strong: string[]; weak: string[]} {
  const strong = new Set<string>();
  const weak = new Set<string>();
  for (const t of text.split(/[^A-Za-z0-9_$]+/)) {
    if (t.length < 4 || /^[\d_$]+$/.test(t) || STOP.has(t.toLowerCase())) {
      continue;
    }
    if (
      !/^[_$]|[a-z][A-Z]|_/.test(t) &&
      !(/^[A-Z][a-z]/.test(t) && t.length >= 6) &&
      t.length < 10
    ) {
      weak.add(t);
      continue;
    }
    strong.add(t);
    // `WAWebAnimatedEmojiAssetLoader` is also `EmojiAssetLoader`, `AssetLoader`.
    const parts = t.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9$]+/g) ?? [];
    for (let i = 1; i <= parts.length - 2; i++) {
      const v = parts.slice(i).join('');
      if (v.length >= 8) strong.add(v);
    }
  }
  return {strong: [...strong], weak: [...weak]};
}

export const leadTerms = (l: RecordedLead) =>
  terms([l.label, l.path ?? '', l.name ?? '', l.edge ?? ''].join(' '));

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasTerm = (text: string, t: string) =>
  new RegExp(`(^|[^A-Za-z0-9_$])${esc(t)}($|[^a-z0-9_$])`, 'i').test(text) ||
  (t.length >= 8 && text.toLowerCase().includes(t.toLowerCase()));

/** The first finding, else not_problem, naming the lead by @id or name. */
export function itemFor(l: RecordedLead, items: DraftItem[]): DraftItem | null {
  const {strong, weak} = leadTerms(l);
  const named = (it: DraftItem) =>
    l.ids.some(id => id > 99 && new RegExp(`\\b${id}\\b`).test(it.text)) ||
    strong.some(t => hasTerm(it.text, t)) ||
    weak.filter(t => hasTerm(it.text, t)).length >= 2;
  return (
    items.find(it => it.kind === 'finding' && named(it)) ??
    items.find(it => it.kind === 'not_problem' && named(it)) ??
    null
  );
}

const SOFT_REASON =
  /\b(bounded|capped|expected|normal|by design|working set|steady|flat|legitimate|intended|necessary|time-windowed|baseline|structural)\b/i;
const EVIDENCE = new Set(['dead', 'duplicate', 'finished', 'growing']);

/** A not_problem whose reason the lead's own evidence contradicts. */
export const isQuestionable = (l: RecordedLead, np: DraftItem): boolean =>
  EVIDENCE.has(l.kind) && SOFT_REASON.test(np.text);

/** The call that checks a lead. */
export function checkCall(l: RecordedLead, many: boolean): string {
  if (l.check != null) return l.check;
  const snap = many && l.snapshot !== '' ? `, snapshot:"${l.snapshot}"` : '';
  if (l.ids.length > 0) {
    return EVIDENCE.has(l.kind)
      ? `memlab_what_if({node_ids:[${l.ids[0]}]${snap}})`
      : `memlab_retainer_trace({node_id:${l.ids[0]}${snap}})`;
  }
  if (l.edge != null) {
    const cut = JSON.stringify([{label: 'x', edge: l.edge}]);
    return `memlab_residual({explained:${cut}${snap}})`;
  }
  return 'memlab_explain_delta({group_by:"anchor"})';
}

type Row = RecordedLead & {more: number};

/** One row per named owner path or holder: ladder rungs fold into the largest. */
export function dedupe(leads: RecordedLead[]): Row[] {
  const by = new Map<string, Row>();
  for (const l of leads) {
    const key =
      l.path != null && terms(l.path).strong.length > 0
        ? `p:${l.path}`
        : terms(l.label).strong.length > 0
          ? `l:${l.label}`
          : `@${l.ids[0] ?? l.label}`; // ids hold across one session's rungs
    const old = by.get(key);
    // Every member's ids still match the draft; the largest one leads.
    // Own copy of `ids`: `l` is the registry's lead, and the merges below
    // append to the row's array.
    if (old == null) by.set(key, {...l, ids: [...l.ids], more: 0});
    else if (l.bytes > old.bytes) {
      by.set(key, {...l, ids: [...l.ids, ...old.ids], more: old.more + 1});
    } else {
      old.ids.push(...l.ids);
      old.more++;
    }
  }
  return [...by.values()].sort((a, b) => b.bytes - a.bytes);
}

const cell = (s: string, n: number) =>
  sanitizeForTable(s.length > n ? `${s.slice(0, n - 1)}…` : s);
const what = (l: Row, n: number) => {
  const at = l.label === '-' && l.name != null ? l.name : l.label;
  const more = l.more > 0 ? ` (+${l.more} more here)` : '';
  const s = l.path != null && l.path !== at ? `${at} · ${l.path}` : at;
  return cell(s, n - more.length) + more;
};
const node = (l: RecordedLead) =>
  l.ids.length > 0 ? `@${l.ids[0]}` : l.edge != null ? `\`${l.edge}\`` : '-';

export function coverageReport(
  leads: RecordedLead[],
  items: DraftItem[],
  minBytes: number,
  limit: number,
): string {
  // Without an id or a name there is nothing to check.
  const all = dedupe(
    leads.filter(
      l =>
        l.bytes >= minBytes &&
        (l.ids.length > 0 || leadTerms(l).strong.length > 0),
    ),
  );
  const many = new Set(all.map(l => l.snapshot)).size > 1;
  const covered = new Map<string, Set<string>>();
  const npOnly: Array<[Row, DraftItem]> = [];
  const open: Row[] = [];
  for (const l of all) {
    const it = itemFor(l, items);
    if (it == null) open.push(l);
    else if (it.kind === 'not_problem') npOnly.push([l, it]);
    else
      covered.set(
        it.label,
        (covered.get(it.label) ?? new Set()).add(cell(l.label, 30)),
      );
  }
  const findings = items.filter(i => i.kind === 'finding').length;
  const named = open.filter(l => leadTerms(l).strong.length > 0);
  const bare = open.filter(l => !named.includes(l));
  const lines = [
    `## Coverage check: ${open.length} of ${all.length} leads (≥ ${formatBytes(minBytes)}) are not in the draft (${findings} findings, ${items.length - findings} not_problems)`,
    '',
    '- Leads to check, not issues: each is a row a tool printed this session, including bottom-up ones (shape clusters, shapes that grew by count, duplicate subscriptions). Drill it, then account for it: a finding, a not_problem with evidence, or `ignored: <reason>` under an Ignored heading.',
  ];
  // A lead with evidence (dead, copies, growth) before one that is only big.
  const signal = named.filter(l => EVIDENCE.has(l.kind));
  for (const [title, rows] of [
    ['with a signal (dead, duplicate, finished or growing)', signal],
    [
      'size only (top retained, or left after the cuts)',
      named.filter(l => !signal.includes(l)),
    ],
  ] as const) {
    if (rows.length === 0) continue;
    lines.push(
      '',
      `### Not covered, ${title}: ${rows.length}, largest first`,
      '',
      markdownTable(
        [
          'Lead (holder · path)',
          'Node',
          'Bytes',
          'Why it surfaced',
          'Source',
          'Check with',
        ],
        rows
          .slice(0, limit)
          .map(l => [
            what(l, 50),
            node(l),
            formatBytes(l.bytes),
            cell(l.why, 60),
            l.source,
            `\`${checkCall(l, many)}\``,
          ]),
        new Set([2]),
      ),
      ...(rows.length > limit
        ? [`… ${rows.length - limit} more (raise \`limit\`).`]
        : []),
    );
  }
  if (bare.length > 0) {
    const ids = bare
      .slice(0, 12)
      .map(l => `${node(l)} ${formatBytes(l.bytes)}`);
    lines.push(
      '',
      `- Also not covered, no holder name to match (by @id only): ${ids.join(', ')}${bare.length > 12 ? ', …' : ''}`,
    );
  }
  if (npOnly.length > 0) {
    lines.push(
      '',
      `### Covered only in not_problems (${npOnly.length}; ⚠ = the reason says bounded/expected/normal but the lead says dead, duplicate, finished or growing: re-check with memlab_what_if)`,
      '',
      markdownTable(
        ['', 'Lead', 'Node', 'Bytes', 'Lead says', 'Draft item'],
        npOnly
          .slice(0, limit)
          .map(([l, it]) => [
            isQuestionable(l, it) ? '⚠' : '',
            what(l, 44),
            node(l),
            formatBytes(l.bytes),
            cell(`${l.kind}: ${l.why}`, 56),
            it.label,
          ]),
        new Set([3]),
      ),
    );
  }
  if (covered.size > 0) {
    const n = [...covered.values()].reduce((s, v) => s + v.size, 0);
    const shown = [...covered].map(
      ([f, ls]) => `${f}: ${[...ls].slice(0, 4).join(', ')}`,
    );
    lines.push('', `- Covered by findings (${n}): ${shown.join('; ')}`);
  }
  return lines.join('\n');
}

export function registerCoverageCheck(server: McpServer): void {
  server.tool(
    'memlab_coverage_check',
    'Run before the final report: lists the leads memlab tools surfaced this session (sweep, including its shape clusters; residual, largest_objects, framework_buffers, growth anchors, duplicated_strings, collection_diff, the shapes diff_snapshots saw grow by count, duplicate_subscriptions) that the draft does not name, largest first, with why each surfaced and the call that checks it. Leads named only in not_problems are listed too, marked ⚠ when the reason is "bounded"/"expected"/"normal" but the lead says dead, duplicate, finished or growing. ' +
      'Matching is by @id, holder and class names. Leads are not issues: drill each before adding it.',
    {
      report_path: z
        .string()
        .optional()
        .describe('A draft report.json (findings, not_problems) or report.md.'),
      text: z
        .string()
        .optional()
        .describe('The draft as text, instead of a file.'),
      min_bytes: z
        .number()
        .optional()
        .default(64 * 1024)
        .describe('Ignore leads smaller than this (default 64 KB).'),
      limit: z
        .number()
        .optional()
        .default(15)
        .describe('Rows per table (default 15).'),
    },
    async ({report_path, text, min_bytes, limit}) => {
      try {
        const raw =
          text ??
          (report_path != null ? fs.readFileSync(report_path, 'utf8') : null);
        if (raw == null) return errorResult('Pass `report_path` or `text`.');
        const leads = allLeads();
        const out =
          leads.length === 0
            ? 'No leads recorded yet: run memlab_sweep, largest_objects, residual or framework_buffers first.'
            : coverageReport(leads, parseDraft(raw), min_bytes, limit);
        return toolResult(out, null);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
