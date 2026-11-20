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
import {z} from 'zod';
import {sizeInput, withSizeHint} from '../byte-size.js';
import {getSnapshot, isLightSnapshot} from '../heap-state.js';
import {withAnonymizedBanner} from '../anonymized-snapshot.js';
import {
  FAMILY_PREFIX_LEN,
  formatStringFamilies,
  stringFamilyCensus,
} from '../string-families.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';

function extractPrefix(value: string, prefixLen: number): string {
  if (value.length <= prefixLen) return value;
  return value.slice(0, prefixLen);
}

export function registerStringPatterns(server: McpServer): void {
  server.tool(
    'memlab_string_patterns',
    'Group strings by common prefix and show aggregate counts and sizes. Instead of seeing 20 individual histogram entries for CSV strings that all start with the same header, see them grouped: "Strings matching prefix: 20 instances, 250 MB total." Useful for identifying families of related strings like API responses, repeated log messages, or duplicated data. Pass `normalize:true` for FAMILIES (digits masked, `data:` URLs by mime) of at least 1 MB with their top holder edges — e.g. 240 per-record `{"query_id":…` blobs as one 7 MB row.',
    {
      prefix_length: z
        .number()
        .optional()
        .default(50)
        .describe(
          'Number of characters to use for prefix grouping (default 50). Shorter values create broader groups.',
        ),
      min_count: z
        .number()
        .optional()
        .default(5)
        .describe('Minimum number of strings in a group to show (default 5)'),
      min_total_size: sizeInput()
        .optional()
        .describe(
          withSizeHint(
            'Minimum total self size in bytes for a group to be shown. Use to filter to significant groups.',
          ),
        ),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of groups to return (default 20)'),
      normalize: z
        .boolean()
        .optional()
        .describe(
          `Group into FAMILIES instead: the first ${FAMILY_PREFIX_LEN} chars with digit runs masked to #, \`data:\` URLs by mime, script source left out. Shows families of at least min_total_size (default 1 MB, or 0.5% of the heap if smaller) with count, flat-string self bytes (no cons/sliced double count), the largest member and the top 2 holder edges. prefix_length and min_count are ignored. The same section memlab_quick_diagnosis prints.`,
        ),
    },
    async ({prefix_length, min_count, min_total_size, limit, normalize}) => {
      try {
        const snapshot = getSnapshot({allowLight: true});
        const light = isLightSnapshot();
        if (normalize === true) {
          const census = stringFamilyCensus(snapshot, {
            minBytes: min_total_size,
            minHeapShare: min_total_size != null ? 0 : undefined,
            limit,
            holders: !light,
          });
          const lines = formatStringFamilies(census);
          return toolResult(
            withAnonymizedBanner(
              snapshot,
              lines.length > 0
                ? lines.join('\n')
                : `No string family reaches ${formatBytes(census.threshold)}.`,
            ),
          );
        }

        const groups = new Map<
          string,
          {
            count: number;
            total_self_size: number;
            total_retained_size: number;
            min_len: number;
            max_len: number;
            example_ids: number[];
          }
        >();

        snapshot.nodes.forEach(node => {
          if (node.type !== 'string') return;
          if (node.name === 'system / SlicedString') return;
          if (node.name === 'system / ConsString') return;
          if (node.id <= 3) return;

          const prefix = extractPrefix(node.name, prefix_length);
          const existing = groups.get(prefix);
          if (existing) {
            existing.count++;
            existing.total_self_size += node.self_size;
            existing.total_retained_size += node.retainedSize;
            existing.min_len = Math.min(existing.min_len, node.name.length);
            existing.max_len = Math.max(existing.max_len, node.name.length);
            if (existing.example_ids.length < 3) {
              existing.example_ids.push(node.id);
            }
          } else {
            groups.set(prefix, {
              count: 1,
              total_self_size: node.self_size,
              total_retained_size: node.retainedSize,
              min_len: node.name.length,
              max_len: node.name.length,
              example_ids: [node.id],
            });
          }
        });

        let filtered = [...groups.entries()].filter(
          ([, g]) => g.count >= min_count,
        );
        if (min_total_size != null) {
          filtered = filtered.filter(
            ([, g]) => g.total_self_size >= min_total_size,
          );
        }

        const sorted = filtered
          .sort((a, b) => b[1].total_self_size - a[1].total_self_size)
          .slice(0, limit);

        if (sorted.length === 0) {
          return toolResult(
            'No string groups found matching the criteria. Try lowering min_count or prefix_length.',
          );
        }

        const headers = [
          'Prefix',
          'Count',
          'Total Size',
          light ? 'Retained (n/a)' : 'Retained',
          'Len Range',
          'Examples',
        ];
        const rightCols = new Set([1, 2, 3]);
        const rows = sorted.map(([prefix, g]) => {
          const displayPrefix =
            prefix.length > 60 ? prefix.slice(0, 60) + '…' : prefix;
          const lenRange =
            g.min_len === g.max_len
              ? formatNumber(g.min_len)
              : `${formatNumber(g.min_len)}-${formatNumber(g.max_len)}`;
          return [
            displayPrefix,
            formatNumber(g.count),
            formatBytes(g.total_self_size),
            light ? 'n/a (light)' : formatBytes(g.total_retained_size),
            lenRange,
            g.example_ids.map(id => `@${id}`).join(', '),
          ];
        });

        return toolResult(
          withAnonymizedBanner(
            snapshot,
            `String patterns (prefix_length=${prefix_length}, ${formatNumber(filtered.length)} groups matching filters, showing ${rows.length})\n\n${markdownTable(headers, rows, rightCols)}`,
          ),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
