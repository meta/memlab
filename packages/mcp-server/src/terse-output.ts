/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {z} from 'zod';

/**
 * Session-wide terse output and machine-readable output.
 *
 * `terseText` keeps what a decision is made from (headings, tables, verdict
 * and warning lines, finding bullets, code) and drops what explains how to
 * read it (italic notes, long prose paragraphs, "next steps" blocks). Applied
 * to every tool's result when the session is terse, so no tool has to opt in.
 *
 * `markdownToJson` turns a report into sections of tables, verdicts and
 * bullets, with numeric cells parsed, for a caller that chains tools.
 */

/** Prose longer than this, with nothing bold or tabular in it, is explanation. */
const PROSE_MAX = 160;
/** An italic note this long is a standing explanation, not a one-line fact. */
const NOTE_MAX = 80;
/** Text after a leading bold verdict longer than this is cut to one sentence. */
const VERDICT_TAIL_MAX = 120;

const NEXT_STEPS_BLOCK =
  /^(\*\*)?(Suggested next steps|Next steps|Next:|Then, before|How to fix)/i;
const NEXT_STEPS_HEADING =
  /^#{2,6}\s+(Suggested next steps|Next steps|How to read)\b/i;

interface Block {
  lines: string[];
  fenced: boolean;
}

/** Blank-line separated blocks; a fenced code block is one block. */
function blocks(text: string): Block[] {
  const out: Block[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  const flush = (fenced = false) => {
    if (cur.length > 0) out.push({lines: cur, fenced});
    cur = [];
  };
  for (const line of text.split('\n')) {
    const marker = /^\s*(`{3,})/.exec(line)?.[1];
    if (fence != null) {
      cur.push(line);
      if (marker != null && marker.length >= fence.length) {
        flush(true);
        fence = null;
      }
      continue;
    }
    if (marker != null) {
      flush();
      fence = marker;
      cur.push(line);
      continue;
    }
    if (line.trim() === '') flush();
    else cur.push(line);
  }
  if (fence != null) flush(true);
  else flush();
  return out;
}

function isStructural(line: string): boolean {
  const t = line.trim();
  return (
    /^(#|\||[-*+] |\d+\. |⚠|> ⚠|> Snapshot)/.test(t) ||
    t.includes('**') ||
    /^\[\d+\]/.test(t)
  );
}

function headingLevel(line: string): number {
  return /^(#{1,6})\s/.exec(line.trim())?.[1].length ?? 0;
}

/** `**Verdict.** a long explanation …` → `**Verdict.** first sentence.` */
function cutVerdictTail(line: string): string {
  const m = /^(\s*(?:[-*] |⚠️?\s*|> ⚠\s*)?\*\*[^*]+\*\*)(.*)$/.exec(line);
  if (m == null || m[2].length <= VERDICT_TAIL_MAX) return line;
  const rest = m[2];
  const first = /^(.*?[.!?])(?=\s+[A-Z`*(_]|$)/.exec(rest.trim())?.[1];
  const colon = rest.trimEnd().endsWith(':') ? ':' : '';
  if (first != null && first.length <= VERDICT_TAIL_MAX) {
    return `${m[1]} ${first}`;
  }
  if (first == null) {
    // No sentence to keep: keep the start of the tail, cut at a word, rather
    // than dropping numbers the verdict may carry there.
    const tail = rest.trim();
    if (tail.length <= VERDICT_TAIL_MAX) return `${m[1]} ${tail}`;
    const cut = tail.slice(0, VERDICT_TAIL_MAX);
    // Drop the last word only when the cut split it.
    const word = /\S/.test(tail[VERDICT_TAIL_MAX])
      ? cut.replace(/\s+\S*$/, '')
      : cut.trimEnd();
    return `${m[1]} ${word.length > 0 ? word : cut}…`;
  }
  return /[.!?:]\*\*$/.test(m[1]) ? m[1] : `${m[1]}${colon}`;
}

function dropBlock(b: Block): boolean {
  if (b.fenced) return false;
  const text = b.lines.join('\n').trim();
  if (NEXT_STEPS_BLOCK.test(text)) return true;
  // A whole-italic note, `_…_`, that explains rather than states.
  if (
    text.startsWith('_') &&
    /_\)?\.?$/.test(text) &&
    text.length >= NOTE_MAX &&
    !text.includes('⚠')
  ) {
    return true;
  }
  if (text.startsWith('> ') && !/^> (⚠|Snapshot)/.test(text)) return true;
  // Plain prose: no structure on any line.
  return text.length >= PROSE_MAX && !b.lines.some(isStructural);
}

/**
 * Trim one tool result to its decision lines. Returns the input unchanged when
 * trimming would leave nothing but headings, so a tool whose whole answer is
 * prose still answers.
 */
export function terseText(text: string): string {
  if (text.trimStart().startsWith('{') || text.trimStart().startsWith('['))
    return text;
  const kept: string[] = [];
  let skipBelow = 0;
  for (const b of blocks(text)) {
    const level = headingLevel(b.lines[0]);
    if (skipBelow > 0) {
      if (level > 0 && level <= skipBelow) skipBelow = 0;
      else continue;
    }
    if (level > 0 && NEXT_STEPS_HEADING.test(b.lines[0].trim())) {
      skipBelow = level;
      continue;
    }
    if (dropBlock(b)) continue;
    if (b.fenced) {
      kept.push(b.lines.join('\n'));
      continue;
    }
    // Inside a mixed block, drop the bare prose lines and keep the rest.
    const lines = b.lines
      .filter(
        l =>
          isStructural(l) ||
          l.length < PROSE_MAX ||
          // A continuation of a list item or table stays with it.
          /^\s{2,}/.test(l),
      )
      .map(cutVerdictTail);
    if (lines.length > 0) kept.push(lines.join('\n'));
  }
  const out = kept.join('\n\n');
  const substantive = kept.some(k => !/^#{1,6}\s/.test(k) || k.includes('\n'));
  return substantive ? out : text;
}

export type JsonCell = string | number | null;

export interface JsonTable {
  columns: string[];
  rows: Array<Record<string, JsonCell>>;
}

export interface JsonSection {
  heading: string | null;
  level: number;
  tables: JsonTable[];
  /** Bold and ⚠ lines: what the section concluded. */
  verdicts: string[];
  bullets: string[];
  text: string[];
}

export interface JsonReport {
  tool: string;
  /** The `> Snapshot…` provenance line, when the result had one. */
  source: string | null;
  sections: JsonSection[];
}

function stripMarkup(s: string): string {
  return s
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^_(.*)_$/, '$1')
    .trim();
}

/** `369,886` and `+42,008` are numbers; `1.2 MB` and `@123` stay text. */
export function parseCell(raw: string): JsonCell {
  const s = stripMarkup(raw);
  if (s === '' || s === '—' || s === '-' || s === '?') return null;
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$|^[+-]?\d+(\.\d+)?$/.test(s)) {
    return Number(s.replace(/[,+]/g, ''));
  }
  return s;
}

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  let code = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '`') {
      code = !code;
      cur += ch;
    } else if (ch === '|' && !code) {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map(c => c.trim());
}

function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

function toTable(header: string[], rows: string[][]): JsonTable {
  const columns = header.map((h, i) => stripMarkup(h) || `col${i + 1}`);
  return {
    columns,
    rows: rows.map(r =>
      Object.fromEntries(columns.map((c, i) => [c, parseCell(r[i] ?? '')])),
    ),
  };
}

function newSection(heading: string | null, level: number): JsonSection {
  return {heading, level, tables: [], verdicts: [], bullets: [], text: []};
}

/** A markdown report as sections of tables, verdicts, bullets and text. */
export function markdownToJson(tool: string, markdown: string): JsonReport {
  const report: JsonReport = {tool, source: null, sections: []};
  let section = newSection(null, 0);
  const push = () => {
    const s = section;
    if (
      s.heading != null ||
      s.tables.length + s.verdicts.length + s.bullets.length + s.text.length > 0
    ) {
      report.sections.push(s);
    }
  };
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t === '') continue;
    const level = headingLevel(t);
    if (level > 0) {
      push();
      section = newSection(stripMarkup(t.replace(/^#+\s*/, '')), level);
      continue;
    }
    if (/^> Snapshots?:/.test(t) && report.source == null) {
      report.source = t.replace(/^>\s*/, '');
      continue;
    }
    if (
      t.startsWith('|') &&
      /^\|[\s:|-]+\|$/.test(lines[i + 1]?.trim() ?? '')
    ) {
      const header = splitRow(t);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      i--;
      section.tables.push(toTable(header, rows));
      continue;
    }
    if (/^`{3,}csv$/.test(t)) {
      const fence = t.replace(/csv$/, '');
      const body: string[] = [];
      // Closed by a fence at least as long as the opening one, as above.
      for (
        i++;
        i < lines.length &&
        !(lines[i].trim().startsWith(fence) && /^`+$/.test(lines[i].trim()));
        i++
      ) {
        body.push(lines[i]);
      }
      if (body.length > 0) {
        section.tables.push(
          toTable(splitCsv(body[0]), body.slice(1).map(splitCsv)),
        );
      }
      continue;
    }
    if (/^`{3,}/.test(t)) {
      const fence = /^`+/.exec(t)?.[0] ?? '```';
      const body: string[] = [line];
      for (i++; i < lines.length; i++) {
        body.push(lines[i]);
        if (lines[i].trim().startsWith(fence)) break;
      }
      section.text.push(body.join('\n'));
      continue;
    }
    if (/^([-*+] |\d+\. )/.test(t)) {
      section.bullets.push(stripMarkup(t.replace(/^([-*+] |\d+\. )/, '')));
      continue;
    }
    if (/^(⚠|> ⚠|\*\*)/.test(t) || /^[A-Z][\w ]{0,40}: \*\*/.test(t)) {
      section.verdicts.push(stripMarkup(t.replace(/^>\s*/, '')));
      continue;
    }
    section.text.push(stripMarkup(t));
  }
  push();
  return report;
}

/** Unpadded markdown: the alignment padding is most of a wide table's tokens. */
/** `|` outside a code span, escaped so it stays inside its cell. */
function escapeCell(cell: string): string {
  let out = '';
  let code = false;
  for (let i = 0; i < cell.length; i++) {
    const ch = cell[i];
    if (ch === '\\' && cell[i + 1] === '|') {
      out += '\\|';
      i++;
    } else if (ch === '`') {
      code = !code;
      out += ch;
    } else {
      out += ch === '|' && !code ? '\\|' : ch;
    }
  }
  // A cell ending in a backslash would escape the next column's `|`; the
  // space is trimmed away when the row is read back.
  return /(^|[^\\])(\\\\)*\\$/.test(out) ? `${out} ` : out;
}

export function compactMarkdownTable(
  headers: string[],
  rows: string[][],
  alignRight?: Set<number>,
): string {
  return [
    `|${headers.map(escapeCell).join('|')}|`,
    `|${headers.map((_, i) => (alignRight?.has(i) ? '--:' : '---')).join('|')}|`,
    ...rows.map(
      r => `|${headers.map((_, i) => escapeCell(r[i] ?? '')).join('|')}|`,
    ),
  ].join('\n');
}

/** The `format` parameter of the tools in `JSON_FORMAT_TOOLS`. */
export const jsonFormatParam = z
  .enum(['markdown', 'json'])
  .optional()
  .default('markdown')
  .describe(
    '"json" returns the report as `{tool, source, sections: [{heading, tables: [{columns, rows}], verdicts, bullets, text}]}`, numeric cells parsed, for chaining into another tool or script. Default "markdown".',
  );
