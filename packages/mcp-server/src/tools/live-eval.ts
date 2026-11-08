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
import {evaluateLive} from '../cdp-capture.js';
import {errorResult, toolResult} from '../utils.js';

export function registerLiveEval(server: McpServer): void {
  server.tool(
    'memlab_live_eval',
    'Evaluate one JavaScript expression in a LIVE page over the Chrome DevTools Protocol and return its JSON value, to check a snapshot hypothesis against the running app (is a global defined, how long is a queue now, which keys does a debug object have) without a harness script. ' +
      'By default V8 refuses any expression it cannot prove side-effect free (`throwOnSideEffect`): property reads, `typeof`, `Object.keys` and array methods work; calling app functions, `require()` and anything that writes are refused. Set `allow_side_effects` to run them anyway. ' +
      'A promise result is awaited; creating one counts as a side effect. Every call has a deadline (`timeout_s`), so a busy or hung page returns an error instead of hanging the server. The code runs in the page with its privileges and session, not in the server.',
    {
      code: z
        .string()
        .describe(
          'The expression to evaluate, e.g. `typeof window.Debug` or `Object.keys(window.Debug ?? {})`.',
        ),
      url_filter: z
        .string()
        .optional()
        .default('')
        .describe(
          'Substring of the page URL to evaluate in (first match). List pages with memlab_capture({list_targets: true}).',
        ),
      port: z
        .number()
        .int()
        .optional()
        .default(9222)
        .describe('Chrome remote-debugging port (default 9222).'),
      timeout_s: z
        .number()
        .positive()
        .optional()
        .default(10)
        .describe('Deadline for the evaluation in seconds (default 10).'),
      allow_side_effects: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Run expressions that V8 cannot prove side-effect free, such as calls into app code. Off by default.',
        ),
      max_chars: z
        .number()
        .int()
        .positive()
        .optional()
        .default(4000)
        .describe('Truncate the printed value to this many characters.'),
    },
    async ({
      code,
      url_filter,
      port,
      timeout_s,
      allow_side_effects,
      max_chars,
    }) => {
      try {
        const r = await evaluateLive({
          port,
          urlFilter: url_filter,
          expression: code,
          timeoutMs: timeout_s * 1000,
          allowSideEffects: allow_side_effects,
        });
        const lines = [
          `## Live eval in ${r.title || r.url}`,
          '',
          `\`${r.url}\` on port ${port}` +
            (r.matches > 1
              ? `; ${r.matches} pages matched \`url_filter\`, the first was used`
              : '') +
            '.',
          '',
        ];
        if (r.exception != null) {
          lines.push(`**Threw:** ${r.exception}`);
          if (!allow_side_effects && /side-effect/i.test(r.exception)) {
            lines.push(
              '',
              'V8 could not prove the expression side-effect free. Rewrite it as reads only, or set `allow_side_effects: true` if running it in the page is intended.',
            );
          }
          return toolResult(lines.join('\n'));
        }
        const json =
          r.value !== undefined ? JSON.stringify(r.value, null, 2) : undefined;
        const text =
          json == null || (json === '{}' && r.description != null)
            ? (r.description ?? 'undefined')
            : json;
        const clipped =
          text.length > max_chars
            ? `${text.slice(0, max_chars)}\n… (${text.length - max_chars} more characters; raise \`max_chars\`)`
            : text;
        const described =
          r.description != null && text !== r.description
            ? `, ${r.description.length > 80 ? `${r.description.slice(0, 79)}…` : r.description}`
            : '';
        lines.push(
          `Result (${r.type}${described}):`,
          '',
          '```',
          clipped,
          '```',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
