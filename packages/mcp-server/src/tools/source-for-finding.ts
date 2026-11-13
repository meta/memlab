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
import {exec} from 'child_process';
import fs from 'fs';
import path from 'path';
import {z} from 'zod';
import {loadFindingIndex} from './finding-index.js';
import {errorResult, markdownTable, toolResult} from '../utils.js';

/**
 * From a finding's retainer path to the files that most likely hold it.
 *
 * A path such as `modulesMap > WAWebAttachMediaGetters > getPreviewable >
 * $$cache > AttachMedia > File` names the module that owns the leak and the
 * field that holds it. Turning that into a file and a line was done by hand
 * for every finding. Module names are resolved to files with the operator's
 * `MEMLAB_SOURCE_LOOKUP_CMD` (a shell command with `{module}` in it that
 * prints matching paths), and each file found on disk is searched for the
 * lines that assign the path's field names.
 */

const LOOKUP_TIMEOUT_MS = 20000;
const MAX_MODULES = 8;
const MAX_FILES = 3;

/** Class names on a path that are runtime or browser types, not app modules. */
const NOT_MODULES = new Set([
  'Window',
  'Object',
  'Array',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'WeakRef',
  'Promise',
  'PromiseReaction',
  'Function',
  'String',
  'FiberNode',
  'FiberRootNode',
  'HTMLDocument',
  'Detached',
  'EventTargetData',
  'RegisteredEventListener',
  'LocalFrame',
  'LocalFrameView',
  'CppHeapExternal',
  'Range',
  'Global',
  'DevTools',
  'File',
  'Blob',
  'URL',
]);

/** Words a written path uses to describe a hop rather than to name one. */
const PATH_WORDS = new Set([
  'context',
  'listener',
  'listeners',
  'exports',
  'module',
  'scope',
  'string',
  'chain',
  'closure',
  'table',
  'elements',
  'instance',
  'entry',
  'number',
]);

export interface PathTokens {
  /** Candidate module names, nearest the retained object first. */
  modules: string[];
  /** Field and variable names on the path. */
  fields: string[];
}

export function pathTokens(text: string): PathTokens {
  const parts = text
    .split(/\s*(?:>|→|->|--\S*-->)\s*/)
    .flatMap(p => p.split(/[\s.,/()[\]{}<>|=]+/))
    .map(t => t.replace(/^['"`]+|['"`:]+$/g, ''))
    .filter(t => t !== '');
  const modules: string[] = [];
  const fields: string[] = [];
  for (const t of parts) {
    if (
      /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(t) &&
      t.length >= 6 &&
      !NOT_MODULES.has(t) &&
      !/^(HTML|SVG|CSS|blink|system|Detached)/.test(t)
    ) {
      if (!modules.includes(t)) modules.push(t);
    } else if (/^[$_a-z][$\w]*$/.test(t) && t.length >= 3) {
      if (!fields.includes(t) && !PATH_WORDS.has(t)) {
        fields.push(t);
      }
    }
  }
  return {modules: modules.reverse(), fields};
}

function lookupCommand(): string | null {
  const cmd = process.env.MEMLAB_SOURCE_LOOKUP_CMD;
  return cmd == null || cmd === '' || !cmd.includes('{module}') ? null : cmd;
}

function runLookup(template: string, module: string): Promise<string[]> {
  return new Promise(resolve => {
    exec(
      template.split('{module}').join(module),
      {timeout: LOOKUP_TIMEOUT_MS},
      (err, stdout) => {
        if (err != null) {
          resolve([]);
          return;
        }
        resolve(
          String(stdout)
            .split('\n')
            .map(l => l.trim())
            .filter(l => /^[\w.@/-]+\/[\w.@-]+\.\w+$/.test(l))
            .slice(0, MAX_FILES),
        );
      },
    );
  });
}

function readable(file: string, roots: string[]): string | null {
  if (path.isAbsolute(file)) return fs.existsSync(file) ? file : null;
  for (const root of roots) {
    const p = path.join(root, file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lines that assign or declare one of `fields`: `x.f =`, `f:`, `let f`. */
export function assigningLines(
  source: string,
  fields: readonly string[],
): Array<{line: number; field: string; text: string}> {
  const out: Array<{line: number; field: string; text: string}> = [];
  const lines = source.split('\n');
  for (const field of fields) {
    const f = escapeRe(field);
    const re = new RegExp(
      `(?:\\.${f}\\s*(?:=(?!=)|\\?\\?=|\\|\\|=)|(?:^|[\\s,{(])${f}\\s*:|\\b(?:const|let|var|function)\\s+${f}\\b|\\b${f}\\s*=(?!=))`,
    );
    let hits = 0;
    for (let i = 0; i < lines.length && hits < 2; i++) {
      if (re.test(lines[i])) {
        out.push({line: i + 1, field, text: lines[i].trim().slice(0, 140)});
        hits++;
      }
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

export function registerSourceForFinding(server: McpServer): void {
  server.tool(
    'memlab_source_for_finding',
    "A finding's likely source files: the module names on its retainer path, resolved to files, and in each file the lines that assign the path's field names. Pass a `fingerprint` from `memlab_finding_index` (its retainer path, or its signature) or a `retainer_path`. " +
      "Module names are resolved with `MEMLAB_SOURCE_LOOKUP_CMD`, a shell command containing `{module}` that prints matching file paths; files are read from `MEMLAB_SOURCE_ROOT` or the working directory. Files are ranked by how many of the path's fields they assign, then by how near the module is to the retained object.",
    {
      fingerprint: z
        .string()
        .optional()
        .describe('A finding in the index, by fingerprint.'),
      retainer_path: z
        .string()
        .optional()
        .describe(
          'A retainer path, root first (`A > B > field > C`), instead of a fingerprint.',
        ),
      workstream: z
        .string()
        .optional()
        .describe(
          'The findings index workstream, as in `memlab_finding_index`.',
        ),
    },
    async ({fingerprint, retainer_path, workstream}) => {
      try {
        let text = retainer_path ?? '';
        if (fingerprint != null && fingerprint !== '') {
          const finding =
            loadFindingIndex(workstream).index.findings[fingerprint];
          if (finding == null) {
            return errorResult(
              new Error(`No finding \`${fingerprint}\` in the index.`),
            );
          }
          const stored = (finding as {retainer_path?: string}).retainer_path;
          text = stored != null && stored !== '' ? stored : finding.signature;
        }
        if (text.trim() === '') {
          return errorResult(
            new Error('Pass `fingerprint` or `retainer_path`.'),
          );
        }
        const {modules, fields} = pathTokens(text);
        const lines = [
          '## Source for finding',
          '',
          `Path: \`${text.slice(0, 200)}\``,
          `Modules (nearest the retained object first): ${modules.length > 0 ? modules.map(m => `\`${m}\``).join(', ') : '(none recognized)'}`,
          `Fields: ${fields.length > 0 ? fields.map(f => `\`${f}\``).join(', ') : '(none)'}`,
          '',
        ];
        const template = lookupCommand();
        if (template == null) {
          lines.push(
            '_Set `MEMLAB_SOURCE_LOOKUP_CMD` to a command with `{module}` in it that prints file paths (for example a filename search for `{module}.js`) to resolve these modules to files._',
          );
          return toolResult(lines.join('\n'));
        }
        const roots = [process.env.MEMLAB_SOURCE_ROOT, process.cwd()].filter(
          (r): r is string => r != null && r !== '',
        );
        const picked = modules.slice(0, MAX_MODULES);
        const found = await Promise.all(
          picked.map(async (module, rank) => ({
            module,
            rank,
            files: await runLookup(template, module),
          })),
        );
        const rows: Array<{
          module: string;
          rank: number;
          file: string;
          local: string | null;
          hits: Array<{line: number; field: string; text: string}>;
        }> = [];
        for (const {module, rank, files} of found) {
          for (const file of files) {
            const local = readable(file, roots);
            let hits: Array<{line: number; field: string; text: string}> = [];
            if (local != null) {
              try {
                hits = assigningLines(fs.readFileSync(local, 'utf8'), fields);
              } catch {
                hits = [];
              }
            }
            rows.push({module, rank, file, local, hits});
          }
        }
        if (rows.length === 0) {
          lines.push(
            `The lookup command found no file for ${picked.map(m => `\`${m}\``).join(', ')}.`,
          );
          return toolResult(lines.join('\n'));
        }
        rows.sort(
          (a, b) =>
            new Set(b.hits.map(h => h.field)).size -
              new Set(a.hits.map(h => h.field)).size || a.rank - b.rank,
        );
        const top = rows.slice(0, MAX_FILES);
        lines.push(
          markdownTable(
            ['File', 'Module', 'Assigns'],
            top.map(r => [
              `\`${r.file}\``,
              r.module,
              r.local == null
                ? '(not on disk here)'
                : r.hits.length === 0
                  ? '—'
                  : [...new Set(r.hits.map(h => h.field))].join(', '),
            ]),
          ),
        );
        for (const r of top) {
          if (r.hits.length === 0) continue;
          lines.push('', `**\`${r.file}\`**`);
          for (const h of r.hits.slice(0, 6)) {
            lines.push(`- line ${h.line} (\`${h.field}\`): \`${h.text}\``);
          }
        }
        if (rows.length > top.length) {
          lines.push(
            '',
            `_${rows.length - top.length} more file(s) matched lower: ${rows
              .slice(top.length, top.length + 5)
              .map(r => `\`${r.file}\``)
              .join(', ')}._`,
          );
        }
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
