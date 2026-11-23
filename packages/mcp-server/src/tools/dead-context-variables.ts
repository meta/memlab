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
import type {IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {sizeInput, withSizeHint} from '../byte-size.js';
import {pageInfo, structuredResult} from '../structured.js';
import {getSnapshot, getSnapshotByHandle} from '../heap-state.js';
import {pageLines, paginate} from '../pagination.js';
import {
  analyzeContexts,
  compareContexts,
  scopeDeadBytes,
  scopeReleasedBytes,
  type ContextAnalysis,
  type DeadScope,
} from '../context-analysis.js';
import {
  clampLabel,
  clampLabelTo,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
} from '../utils.js';

// One heap-wide pass per snapshot; paging and filters reuse it.
const cache = new WeakMap<IHeapSnapshot, ContextAnalysis>();

/** Dead slots as `contextId:name`, or null if the analysis has not run. */
export function cachedDeadSlots(snapshot: IHeapSnapshot): Set<string> | null {
  const analysis = cache.get(snapshot);
  if (analysis == null) return null;
  const slots = new Set<string>();
  for (const scope of analysis.scopes) {
    for (const ctx of scope.contexts) {
      for (const f of ctx.deadFields) slots.add(`${ctx.contextId}:${f.name}`);
    }
  }
  return slots;
}

export function deadContextAnalysis(snapshot: IHeapSnapshot): ContextAnalysis {
  let analysis = cache.get(snapshot);
  if (analysis == null) {
    analysis = analyzeContexts(snapshot);
    cache.set(snapshot, analysis);
  }
  return analysis;
}

/**
 * The scopes with only the dead fields that pass the filters. Unless
 * `includeShared`, a field whose value something other than dead slots also
 * holds (nothing freed by clearing it) is dropped and counted in `shared`.
 */
function filterScopes(
  scopes: DeadScope[],
  script: string | undefined,
  minRetained: number,
  includeShared: boolean,
): {scopes: DeadScope[]; shared: {fields: number; bytes: number}} {
  const needle = script?.toLowerCase();
  const out: DeadScope[] = [];
  const shared = {fields: 0, bytes: 0};
  for (const scope of scopes) {
    if (needle != null && !scope.scriptName.toLowerCase().includes(needle)) {
      continue;
    }
    const contexts = scope.contexts
      .map(c => {
        const deadFields = c.deadFields.filter(f => {
          if (f.retainedSize < minRetained) return false;
          if (includeShared || f.releasedSize > 0 || f.deadHolders > 0) {
            return true;
          }
          shared.fields++;
          shared.bytes += f.retainedSize;
          return false;
        });
        return {
          ...c,
          deadFields,
          deadRetainedSize: deadFields.reduce((s, f) => s + f.retainedSize, 0),
          deadReleasedSize: deadFields.reduce((s, f) => s + f.releasedSize, 0),
        };
      })
      .filter(c => c.deadFields.length > 0)
      .sort(compareContexts);
    if (contexts.length > 0) out.push({...scope, contexts});
  }
  out.sort(
    (a, b) =>
      scopeReleasedBytes(b) - scopeReleasedBytes(a) ||
      scopeDeadBytes(b) - scopeDeadBytes(a),
  );
  return {scopes: out, shared};
}

/** Each dead variable of a scope across its contexts: `name ×contexts → frees`. */
function variableSummary(scope: DeadScope, limit: number): string {
  const byName = new Map<string, {contexts: number; released: number}>();
  for (const c of scope.contexts) {
    for (const f of c.deadFields) {
      const v = byName.get(f.name) ?? {contexts: 0, released: 0};
      v.contexts++;
      v.released += f.releasedSize;
      byName.set(f.name, v);
    }
  }
  const rows = [...byName.entries()].sort(
    (a, b) => b[1].released - a[1].released || b[1].contexts - a[1].contexts,
  );
  const shown = rows
    .slice(0, limit)
    .map(
      ([name, v]) =>
        `\`${name}\`${v.contexts > 1 ? ` ×${formatNumber(v.contexts)}` : ''} → ${formatBytes(v.released)}`,
    );
  if (rows.length > limit) shown.push(`+${rows.length - limit}`);
  return shown.join(', ');
}

function noMetadataText(analysis: ContextAnalysis): string {
  const scripts = analysis.scriptsWithoutScopes;
  const contexts = scripts.reduce((s, x) => s + x.contextCount, 0);
  return [
    '**Dead captured variables: not available for this snapshot.**',
    '',
    'The snapshot has no source scope tree (`meta.scope_fields` is absent). V8 writes it from version 15.6 (Chrome 156), and from 15.7 (Chrome 157) without script-level `let`/`const`, which any later script can read. Re-capture with Chrome 157 or newer to run this analysis.',
    '',
    `${formatNumber(contexts)} contexts in ${formatNumber(scripts.length)} scripts could not be checked. ` +
      'To inspect one closure by hand, use `memlab_closure_inspection`.',
  ].join('\n');
}

function scopeLabel(scope: DeadScope): string {
  const name = scope.scopeName || '(anonymous)';
  return `${name} [${scope.start}–${scope.end}]`;
}

export function registerDeadContextVariables(server: McpServer): void {
  server.tool(
    'memlab_dead_context_variables',
    'Find captured variables that no live code can read, heap-wide. Closures created in one scope share one Context, so a variable read only by a callback that is gone stays alive as long as ANY sibling closure does. ' +
      'Using the source scope tree V8 embeds in the snapshot (V8 15.6+ / Chrome 156+), this checks every Context slot against the closures and suspended async frames still on the heap and reports the slots nothing live can read, grouped by scope (function and source position) and ranked by what clearing them would FREE: a value is counted only when the slot is the one edge into it from outside its own dominator subtree. A value held only by dead slots of several contexts (or two of one) is listed with how many hold it, since clearing them all frees it. A dead slot whose value something else also holds (the shared `Window` or `Document`) frees nothing and is left out unless `include_shared` is set. ' +
      'Each row gives the script, the scope name and source offsets, the Context id and the dead value ids, ready for `memlab_retainer_trace` or `memlab_closure_inspection`. ' +
      'Snapshots from older V8 have no scope tree; the tool then says so and lists how many contexts could not be checked. Scripts that own contexts but have no scope tree are listed at the end.',
    {
      handle: z
        .string()
        .optional()
        .describe('Snapshot to analyze (defaults to the active one).'),
      script: z
        .string()
        .optional()
        .describe('Only scopes whose script name contains this text.'),
      min_retained_size: sizeInput()
        .optional()
        .default(0)
        .describe(
          withSizeHint(
            'Only dead variables whose value retains at least this much (default 0).',
          ),
        ),
      include_shared: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Also list dead variables whose value something other than a dead slot also holds, so clearing them frees nothing (default false).',
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(0)
        .describe('Index of the first scope to show (default 0).'),
      page_size: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(10)
        .describe('Scopes per page (default 10).'),
      contexts_per_scope: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(1)
        .describe('Contexts listed per scope, largest first (default 1).'),
      fields_per_context: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(3)
        .describe(
          'Dead variables listed per context, largest first (default 3).',
        ),
    },
    async ({
      handle,
      script,
      min_retained_size,
      include_shared,
      offset,
      page_size,
      contexts_per_scope,
      fields_per_context,
    }) => {
      try {
        const snapshot =
          handle != null ? getSnapshotByHandle(handle) : getSnapshot();
        if (snapshot == null) {
          return errorResult(
            new Error(`Snapshot "${handle}" is not resident.`),
          );
        }
        const analysis = deadContextAnalysis(snapshot);
        if (!analysis.hasScopeMetadata) {
          return structuredResult(
            noMetadataText(analysis),
            {
              has_scope_metadata: false,
              scripts_without_scopes: analysis.scriptsWithoutScopes.map(x => ({
                script_id: x.scriptId,
                script: x.scriptName,
                contexts: x.contextCount,
              })),
            },
            {snapshot: handle},
          );
        }

        const {scopes, shared} = filterScopes(
          analysis.scopes,
          script,
          min_retained_size,
          include_shared,
        );
        const contextCount = scopes.reduce((s, x) => s + x.contexts.length, 0);
        const fieldCount = scopes.reduce(
          (s, x) => s + x.contexts.reduce((t, c) => t + c.deadFields.length, 0),
          0,
        );
        const deadBytes = scopes.reduce((s, x) => s + scopeDeadBytes(x), 0);
        const releasedBytes = scopes.reduce(
          (s, x) => s + scopeReleasedBytes(x),
          0,
        );
        const jointly = new Map<number, number>();
        for (const scope of scopes) {
          for (const c of scope.contexts) {
            for (const f of c.deadFields) {
              if (f.deadHolders > 0) jointly.set(f.valueId, f.retainedSize);
            }
          }
        }
        const jointBytes = [...jointly.values()].reduce((s, b) => s + b, 0);
        const lines = [
          `**Dead captured variables:** ${formatNumber(fieldCount)} in ${formatNumber(contextCount)} contexts across ${formatNumber(scopes.length)} scopes; clearing them frees ${formatBytes(releasedBytes)}`,
          `Checked ${formatNumber(analysis.contextCount)} contexts against ${formatNumber(analysis.liveClosureCount)} live closures and suspended frames. ` +
            '"Frees" counts a value only when the slot is the one thing outside the value that holds it.' +
            (jointly.size > 0
              ? ` ${formatNumber(jointly.size)} value(s) (${formatBytes(jointBytes)} retained) are held only by several dead slots: no one slot frees them, clearing all of their dead slots does.`
              : '') +
            (shared.fields > 0
              ? ` ${formatNumber(shared.fields)} dead variable(s) whose value something other than a dead slot also holds (${formatBytes(shared.bytes)} retained, nothing freed) are left out; \`include_shared: true\` lists them.`
              : ''),
        ];
        if (scopes.length === 0) {
          lines.push('', 'No dead captured variables match.');
        }

        const paged = paginate(scopes, offset, page_size);
        const page = paged.items;
        const first = paged.offset;
        if (page.length > 0) {
          lines.push('');
          lines.push(
            markdownTable(
              [
                '#',
                'Scope',
                'Script',
                'Contexts',
                'Frees',
                'Dead variables (×contexts → frees)',
              ],
              page.map((scope, i) => [
                String(first + i + 1),
                scopeLabel(scope),
                // A script URL, not a node name: the session name width does
                // not apply.
                clampLabelTo(scope.scriptName || `@${scope.scriptId}`, 60),
                formatNumber(scope.contexts.length),
                formatBytes(scopeReleasedBytes(scope)),
                variableSummary(scope, 3),
              ]),
              new Set([3, 4]),
            ),
          );
          const rootScopes = page.filter(s => s.isRootScope);
          for (const [i, scope] of page.entries()) {
            lines.push('');
            lines.push(
              `**${first + i + 1}. ${scopeLabel(scope)}** (ScopeInfo @${scope.scopeInfoId}, ${formatNumber(scope.fieldCount)} context slots)`,
            );
            for (const ctx of scope.contexts.slice(0, contexts_per_scope)) {
              lines.push(
                `- Context @${ctx.contextId} (retains ${formatBytes(ctx.retainedSize)}; clearing its dead variables frees ${formatBytes(ctx.deadReleasedSize)})`,
              );
              for (const f of ctx.deadFields.slice(0, fields_per_context)) {
                const name = clampLabel(f.valueName, 60);
                lines.push(
                  `  - \`${f.name}\` → @${f.valueId} ${f.valueType} ${name} (${
                    f.deadHolders > 0
                      ? `held only by ${formatNumber(f.deadHolders)} dead slots: clearing them all frees ${formatBytes(f.retainedSize)}`
                      : `frees ${formatBytes(f.releasedSize)}${f.releasedSize !== f.retainedSize ? ` of ${formatBytes(f.retainedSize)} retained` : ''}`
                  })`,
                );
              }
              if (ctx.deadFields.length > fields_per_context) {
                lines.push(
                  `  - … ${formatNumber(ctx.deadFields.length - fields_per_context)} more`,
                );
              }
            }
            if (scope.contexts.length > contexts_per_scope) {
              lines.push(
                `- … ${formatNumber(scope.contexts.length - contexts_per_scope)} more contexts of this scope`,
              );
            }
          }
          if (rootScopes.length > 0) {
            lines.push('');
            lines.push(
              "_Rows for a script's root scope are module scopes on V8 15.7+. On a V8 15.6 capture they can be script-level `let`/`const`, which other scripts may read, so confirm those before acting._",
            );
          }
          lines.push('', ...pageLines(paged, 'scopes'));
        }

        const missing = analysis.scriptsWithoutScopes;
        if (missing.length > 0) {
          const contexts = missing.reduce((s, x) => s + x.contextCount, 0);
          lines.push('');
          lines.push(
            `**Scripts without a scope tree:** ${formatNumber(missing.length)} (${formatNumber(contexts)} contexts not checked): ` +
              missing
                .slice(0, 5)
                .map(
                  s =>
                    `${s.scriptName || `@${s.scriptId}`} (${formatNumber(s.contextCount)})`,
                )
                .join(', ') +
              (missing.length > 5 ? `, … ${missing.length - 5} more` : ''),
          );
        }
        return structuredResult(
          lines.join('\n'),
          {
            has_scope_metadata: true,
            dead_retained_size: deadBytes,
            released_size: releasedBytes,
            held_only_by_dead_slots: {values: jointly.size, bytes: jointBytes},
            shared_left_out: shared,
            scopes: page.map(scope => ({
              scope_info_id: scope.scopeInfoId,
              script: scope.scriptName,
              script_id: scope.scriptId,
              name: scope.scopeName,
              start: scope.start,
              end: scope.end,
              dead_retained_size: scopeDeadBytes(scope),
              released_size: scopeReleasedBytes(scope),
              contexts: scope.contexts.map(c => ({
                context_id: c.contextId,
                retained_size: c.retainedSize,
                dead_retained_size: c.deadRetainedSize,
                released_size: c.deadReleasedSize,
                dead_fields: c.deadFields.map(f => ({
                  name: f.name,
                  value_id: f.valueId,
                  value_type: f.valueType,
                  retained_size: f.retainedSize,
                  released_size: f.releasedSize,
                  dead_holders: f.deadHolders,
                })),
              })),
            })),
            pagination: pageInfo(paged),
            scripts_without_scopes: analysis.scriptsWithoutScopes.map(x => ({
              script_id: x.scriptId,
              script: x.scriptName,
              contexts: x.contextCount,
            })),
          },
          {snapshot: handle},
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
