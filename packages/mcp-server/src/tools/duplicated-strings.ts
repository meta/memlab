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
import {pageInfo, structuredResult} from '../structured.js';
import {offsetParam, pageLines, paginate} from '../pagination.js';
import {getSnapshot} from '../heap-state.js';
import {withAnonymizedBanner} from '../anonymized-snapshot.js';
import {
  flattenString,
  formatBytes,
  formatNumber,
  errorResult,
  toolResult,
  looksLikeFailurePayload,
  suggestionsSuppressed,
} from '../utils.js';
import {classifyNonProductionString} from '../artifact-classes.js';
import {buildStringIndex, stringIndexIsCached} from '../string-index.js';

const ROPE_PREFIX_CHARS = 120;

/**
 * `(concatenated string)` ROOTS (ropes no other rope holds as `first` /
 * `second`) grouped by their first characters. A rope's own text is never a
 * flat string, so it is absent from the per-value table however many copies
 * exist.
 */
function concatenatedFamilies(
  snapshot: IHeapSnapshot,
  minCount: number,
  limit: number,
  includeNodeIds: boolean,
): string {
  const families = new Map<
    string,
    {count: number; retained: number; example: number; truncated: boolean}
  >();
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (node.type !== 'concatenated string') return;
    for (const e of node.referrers) {
      const name = String(e.name_or_index);
      if (
        (name === 'first' || name === 'second') &&
        e.fromNode.type === 'concatenated string'
      ) {
        return;
      }
    }
    const flat = flattenString(node, ROPE_PREFIX_CHARS, 5_000, 'marker');
    if (flat.value === '') return;
    const f = families.get(flat.value);
    if (f) {
      f.count++;
      f.retained += node.retainedSize;
    } else {
      families.set(flat.value, {
        count: 1,
        retained: node.retainedSize,
        example: node.id,
        truncated: flat.truncated,
      });
    }
  });
  const top = [...families.entries()]
    .filter(([, f]) => f.count >= minCount)
    .sort((a, b) => b[1].retained - a[1].retained)
    .slice(0, limit);
  if (top.length === 0) return '';
  return (
    `\n\n### Concatenated strings by leading text (${formatNumber(top.length)} famil${top.length === 1 ? 'y' : 'ies'})\n\n` +
    top
      .map(
        ([prefix, f]) =>
          `- **${formatNumber(f.count)}×** ${formatBytes(f.retained)} retained — "${prefix.replace(/\s+/g, ' ').slice(0, ROPE_PREFIX_CHARS)}${f.truncated ? '…' : ''}"` +
          (includeNodeIds ? ` e.g. \`@${f.example}\`` : ''),
      )
      .join('\n') +
    '\n\n_Grouped by the first ' +
    `${ROPE_PREFIX_CHARS} characters; \`‹slice›\` marks a sliced substring. Read one in full with \`memlab_get_string\` or \`helpers.stringValue(id)\`._`
  );
}

const OWNER_VALUES = 200;
const OWNER_EDGE_GUARD = 1024;

/**
 * The parent's shape: its class name, or for a plain `Object` its sorted
 * property names (up to 12). Never `parent.references`, which materializes
 * every edge; a parent over the edge guard is named by class alone.
 */
function ownerShape(parent: IHeapNode): string {
  if (parent.name !== 'Object' || parent.edge_count > OWNER_EDGE_GUARD) {
    return parent.name || 'Object';
  }
  const props: string[] = [];
  let scanned = 0;
  parent.forEachReference(edge => {
    if (++scanned > 256) return {stop: true};
    if (edge.type === 'property') {
      props.push(String(edge.name_or_index));
      if (props.length >= 12) return {stop: true};
    }
  });
  if (props.length === 0) return 'Object';
  props.sort();
  return `{${props.slice(0, 6).join(', ')}${props.length > 6 ? ', …' : ''}}`;
}

/**
 * Duplicated values regrouped by the structure that holds them. Several
 * duplicated values held as different fields of one shape (the fields of a
 * request's params object) are one finding: that object is copied, at least
 * as many times as its most-copied field.
 */
function owningStructures(
  snapshot: IHeapSnapshot,
  ranked: ReadonlyArray<
    [string, {count: number; totalSize: number; exampleIds: number[]}]
  >,
  limit: number,
  includeNodeIds: boolean,
): string {
  const shapes = new Map<
    string,
    {
      fields: Map<string, {value: string; copies: number}>;
      savings: number;
      example: number;
    }
  >();
  for (const [value, stats] of ranked.slice(0, OWNER_VALUES)) {
    // Each sampled copy votes for its first property holder; the value's
    // copies are split between shapes in proportion to the votes.
    const votes = new Map<string, {prop: string; n: number; owner: number}>();
    let sampled = 0;
    for (const id of stats.exampleIds) {
      const node = snapshot.getNodeById(id);
      if (!node) continue;
      let holder: {prop: string; owner: IHeapNode} | null = null;
      let seen = 0;
      node.forEachReferrer(ref => {
        if (++seen > 8) return {stop: true};
        if (ref.type === 'property') {
          holder = {prop: String(ref.name_or_index), owner: ref.fromNode};
          return {stop: true};
        }
      });
      sampled++;
      if (holder == null) continue;
      const {prop, owner} = holder as {prop: string; owner: IHeapNode};
      const key = `${ownerShape(owner)}\u0000${prop}`;
      const v = votes.get(key) ?? {prop, n: 0, owner: owner.id};
      v.n++;
      votes.set(key, v);
    }
    if (sampled === 0) continue;
    const perCopy = stats.totalSize / stats.count;
    for (const [key, v] of votes) {
      const shape = key.slice(0, key.indexOf('\u0000'));
      const copies = Math.round((stats.count * v.n) / sampled);
      if (copies < 2) continue;
      const s = shapes.get(shape) ?? {
        fields: new Map(),
        savings: 0,
        example: v.owner,
      };
      const prev = s.fields.get(v.prop);
      if (prev == null || prev.copies < copies) {
        s.fields.set(v.prop, {value, copies});
      }
      s.savings += (copies - 1) * perCopy;
      shapes.set(shape, s);
    }
  }
  const top = [...shapes.entries()]
    .filter(([, s]) => s.fields.size >= 2)
    .sort((a, b) => b[1].savings - a[1].savings)
    .slice(0, limit);
  if (top.length === 0) return '';
  const clip = (v: string) =>
    (v.length > 40 ? `${v.slice(0, 40)}…` : v).replace(/\s+/g, ' ');
  return (
    `\n\n### Duplicated values by owning structure (${formatNumber(top.length)})\n\n` +
    top
      .map(([shape, s]) => {
        const fields = [...s.fields.entries()].sort(
          (a, b) => b[1].copies - a[1].copies,
        );
        const most = fields[0][1].copies;
        return (
          `- \`${shape}\`: ${formatNumber(fields.length)} duplicated fields, so at least **${formatNumber(most)} copies of this object**; savings ${formatBytes(s.savings)}` +
          (includeNodeIds ? ` (e.g. \`@${s.example}\`)` : '') +
          '\n  ' +
          fields
            .slice(0, 6)
            .map(
              ([prop, f]) =>
                `\`.${prop}\` "${clip(f.value)}" ×${formatNumber(f.copies)}`,
            )
            .join(' · ') +
          (fields.length > 6 ? ` · +${fields.length - 6} more` : '')
        );
      })
      .join('\n') +
    `\n\n_From the ${formatNumber(Math.min(ranked.length, OWNER_VALUES))} largest duplicated values: each sampled copy is attributed to the first object holding it as a property. A shape with several duplicated fields is one object copied many times; deduplicating the object (or the request that builds it) reclaims all its fields at once._`
  );
}

export function registerDuplicatedStrings(server: McpServer): void {
  server.tool(
    'memlab_duplicated_strings',
    'Find duplicated string instances in the heap. Shows strings that appear multiple times, ranked by total retained size — a common source of memory waste. Use after memlab_class_histogram shows high string counts. ' +
      'Also regroups the largest duplicated values by the object shape holding them, so several duplicated fields of one copied object read as that object. ' +
      '⚠ Full-heap scan — slow and memory-heavy on very large heaps (millions of nodes); raise min_count to bound the work.',
    {
      limit: z
        .number()
        .optional()
        .default(15)
        .describe('Maximum number of results (default 15)'),
      offset: offsetParam(),
      min_count: z
        .number()
        .optional()
        .default(2)
        .describe(
          'Minimum number of copies to include (default 2). Increase to focus on heavily duplicated strings (e.g., 100).',
        ),
      concatenated: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Also group `(concatenated string)` ropes by their leading text (default true). The flat-string table cannot see them: a stack trace or log line built with `+` is a rope, and 1,068 copies of one 9 KB Error stack read as nothing there.',
        ),
      include_node_ids: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Include example node IDs in the output for follow-up with retainer_summary. Omitted by default to save ~20-30 tokens per entry.',
        ),
    },
    async ({limit, offset, min_count, concatenated, include_node_ids}) => {
      try {
        const snapshot = getSnapshot();

        // Shared with memlab_intern_opportunities, which needs the same
        // value -> {count, size, ids} map. Cached per snapshot, so running the
        // two back to back (the common case) walks every string node once
        // instead of twice.
        const reused = stringIndexIsCached();
        const {byValue: stringMap} = buildStringIndex(snapshot);

        const ranked = Array.from(stringMap.entries())
          .filter(([, stats]) => stats.count >= min_count)
          .sort(
            (a, b) =>
              b[1].totalSize - a[1].totalSize ||
              (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
          );
        const page = paginate(ranked, offset, limit);
        const duplicated = page.items.map(([value, stats]) => {
          const per_copy_size =
            stats.count > 0 ? stats.totalSize / stats.count : 0;
          const potential_savings = (stats.count - 1) * per_copy_size;
          return {
            value: value.length > 200 ? value.substring(0, 200) + '...' : value,
            count: stats.count,
            total_size: stats.totalSize,
            total_size_formatted: formatBytes(stats.totalSize),
            potential_savings,
            example_node_ids: stats.exampleIds.slice(0, 3),
            field_context: null as string | null,
            actionability: null as string | null,
            harness_what: null as string | null,
          };
        });

        if (duplicated.length === 0) {
          return toolResult('No duplicated strings found.');
        }

        // For top entries, sample referrer objects to show field context
        for (const d of duplicated.slice(0, 10)) {
          const propCounts = new Map<
            string,
            {count: number; ownerName: string}
          >();
          for (const nodeId of d.example_node_ids) {
            const node = snapshot.getNodeById(nodeId);
            if (!node) continue;
            for (const ref of node.referrers) {
              if (ref.type === 'property' || ref.type === 'context') {
                const propName = String(ref.name_or_index);
                const entry = propCounts.get(propName);
                if (entry) {
                  entry.count++;
                } else {
                  propCounts.set(propName, {
                    count: 1,
                    ownerName: ref.fromNode.name,
                  });
                }
              }
            }
          }
          if (propCounts.size > 0) {
            const topProp = [...propCounts.entries()].sort(
              (a, b) => b[1].count - a[1].count,
            )[0];
            d.field_context = `.${topProp[0]} on \`${topProp[1].ownerName}\` instances`;
          }

          // Classify actionability: app vs framework vs mixed
          let appCount = 0;
          let frameworkCount = 0;
          for (const nodeId of d.example_node_ids) {
            const node = snapshot.getNodeById(nodeId);
            if (!node) continue;
            for (const ref of node.referrers) {
              const fromName = ref.fromNode.name;
              const edgeName = String(ref.name_or_index);
              const isFramework =
                fromName.startsWith('system /') ||
                fromName === 'Module' ||
                fromName === '(object properties)' ||
                edgeName === 'map' ||
                edgeName === 'table' ||
                edgeName === 'elements';
              if (isFramework) {
                frameworkCount++;
              } else {
                appCount++;
              }
            }
          }
          // Non-production content outranks the app/framework split: whether it
          // was injected by the measurement harness or exists only in a DEV
          // build, it is not memory the shipped app has, so it must never be
          // counted toward an interning win (see classifyNonProductionString).
          const nonProd = classifyNonProductionString(d.value);
          if (nonProd != null) {
            d.actionability = 'harness';
            d.harness_what =
              nonProd.kind === 'dev-build'
                ? `${nonProd.what} — DEV build only, absent in production`
                : nonProd.what;
          } else if (appCount > 0 && frameworkCount > 0) {
            d.actionability = 'mixed';
          } else if (frameworkCount > 0) {
            d.actionability = 'framework';
          } else {
            d.actionability = 'app';
          }
        }

        const appActionableCount = duplicated.filter(
          d => d.actionability === 'app' || d.actionability === 'mixed',
        ).length;
        const harnessEntries = duplicated.filter(
          d => d.actionability === 'harness',
        );
        const harnessBytes = harnessEntries.reduce(
          (sum, d) => sum + d.potential_savings,
          0,
        );

        const lines = duplicated.map((d, i) => {
          const val =
            d.value.length > 80 ? d.value.slice(0, 80) + '...' : d.value;
          const nodeIdsPart = include_node_ids
            ? ` (nodes: ${d.example_node_ids.map(id => `@${id}`).join(', ')})`
            : '';
          const context = d.field_context
            ? `\n   commonly held as: ${d.field_context}`
            : '';
          const actionLabel =
            d.actionability === 'harness'
              ? ` [harness — ${d.harness_what ?? 'measurement harness'}; not app memory]`
              : d.actionability
                ? ` [${d.actionability}]`
                : '';
          const savingsLabel =
            d.potential_savings > 0
              ? `, savings: ${formatBytes(d.potential_savings)}`
              : '';
          return `${page.offset + i + 1}. "${val}" x ${d.count} copies, ${d.total_size_formatted} total${savingsLabel}${actionLabel}${nodeIdsPart}${context}`;
        });
        // Cached failure payloads: duplicated JSON-ish strings carrying an
        // explicit failure/error marker. These are both wasted memory and a
        // signal that an upstream dependency is failing (and that failures are
        // being cached). Feedback round 4 §D.
        const failurePayloads = duplicated.filter(d =>
          looksLikeFailurePayload(d.value),
        );

        const hasHeavyDups = duplicated.some(d => d.count >= 1000);
        const suggestions: string[] = [];
        if (failurePayloads.length > 0) {
          const totalFailureCopies = failurePayloads.reduce(
            (sum, d) => sum + d.count,
            0,
          );
          const failureBytes = failurePayloads.reduce(
            (sum, d) => sum + d.total_size,
            0,
          );
          suggestions.push(
            `⚠️ **Cached failure payloads detected:** ${failurePayloads.length} of the duplicated strings look like cached error/failure responses ` +
              `(${formatNumber(totalFailureCopies)} copies, ${formatBytes(failureBytes)}). ` +
              'This usually means an upstream dependency is failing AND those failures are being cached. ' +
              'Check the upstream call (permissions, timeouts, bad input) and avoid caching error responses (or cache them with a short TTL).',
          );
        }
        if (hasHeavyDups) {
          suggestions.push(
            '**Suggested action:** Heavily duplicated strings often come from `JSON.parse()` or API responses. ' +
              'Consider string interning with a `Map<string, string>` pool applied at ingestion time, ' +
              'or deduplicating at the data source.',
          );
        }

        // Harness content is excluded from the headline: the number a caller
        // acts on must be reclaimable from the application.
        const totalSavings = duplicated.reduce(
          (sum, d) =>
            d.actionability === 'harness' ? sum : sum + d.potential_savings,
          0,
        );

        const summaryLine =
          appActionableCount > 0
            ? `${appActionableCount} of ${duplicated.length} entries are app-actionable`
            : `${duplicated.length} entries (all framework-held)`;

        const harnessNote =
          harnessEntries.length > 0
            ? `\n\n⚠️ **${harnessEntries.length} entr${harnessEntries.length === 1 ? 'y' : 'ies'} (${formatBytes(harnessBytes)}) excluded from the total as measurement-harness content** — the CDP/devtools bridge injected into the page to drive this session, not application memory. Interning it reclaims nothing in production.`
            : '';

        // The two string tools answer different questions and their outputs
        // used to restate each other. Say which is which, once, and note that
        // the expensive scan is shared rather than repeated.
        const relatedNote = `\n\n_This is the raw per-VALUE duplication table. \`memlab_intern_opportunities\` groups the same strings by property x parent shape and estimates what a canonical intern pool would actually reclaim (accounting for co-retention and the length cap) — use it to decide whether to write the fix, and this to see the values. It reuses this snapshot's string scan${reused ? ', which was itself already cached' : ''}, so running both costs one pass over the string nodes, not two._`;

        const ownerSection = owningStructures(
          snapshot,
          ranked,
          Math.min(limit, 8),
          include_node_ids,
        );
        const ropeSection = concatenated
          ? concatenatedFamilies(
              snapshot,
              min_count,
              Math.min(limit, 10),
              include_node_ids,
            )
          : '';
        const body = `Duplicated strings (${summaryLine}):\n\n${lines.join('\n')}\n\n**${page.total > page.items.length ? 'Interning savings for the rows shown' : 'Total interning savings'}: ${formatBytes(totalSavings)}** (if each string were stored only once, harness content excluded)\n${pageLines(page, 'duplicated values').join('\n')}${harnessNote}${ownerSection}${ropeSection}${suggestionsSuppressed('memlab_duplicated_strings') ? '' : relatedNote}`;
        return structuredResult(
          withAnonymizedBanner(
            snapshot,
            suggestions.length > 0
              ? `${body}\n\n---\n\n${suggestions.join('\n')}`
              : body,
          ),
          {
            strings: duplicated.map(d => ({
              value: d.value,
              count: d.count,
              total_size: d.total_size,
              potential_savings: d.potential_savings,
              actionability: d.actionability,
              example_node_ids: d.example_node_ids,
            })),
            pagination: pageInfo(page),
          },
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
