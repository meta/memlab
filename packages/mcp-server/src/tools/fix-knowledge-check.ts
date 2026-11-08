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
import {
  FIX_PATTERNS,
  FIX_QUESTIONS,
  FIX_TOPICS,
  fixPatternFor,
  questionsFor,
} from '../fix-knowledge.js';
import {errorResult, toolResult} from '../utils.js';

export function registerFixKnowledgeCheck(server: McpServer): void {
  server.tool(
    'memlab_fix_knowledge_check',
    'Before writing a leak fix, answer true/false questions on the beliefs that most often send a fix the wrong way: a WeakMap hop read as the cause, a field nulled on a copy React keeps, a cache filling up read as a leak, a dev-only chain, a cleanup removed with a different function. ' +
      '`action: "ask"` lists the questions (optionally only `topics`) without answers. `action: "grade"` takes `answers` (question id -> true/false), grades every answered question plus any unanswered one in `topics`, and says which are wrong, why, and what to measure. Answer from what you know before looking anything up; a wrong answer is the cue to re-check the trace before the fix is written. ' +
      '`action: "pattern"` prints the fix that has worked for a leak family (`family`), the test that catches its usual mistake, and the questions to answer first; the tools that detect each family point here. ' +
      `Topics: ${FIX_TOPICS.join(', ')}. Reads nothing from disk or the snapshot.`,
    {
      action: z
        .enum(['ask', 'grade', 'pattern'])
        .describe(
          '"ask", "grade", or "pattern" (the known fix shape for a leak family).',
        ),
      family: z
        .string()
        .optional()
        .describe(
          `For "pattern": ${FIX_PATTERNS.map(p => `"${p.id}"`).join(', ')}. Omit for all of them.`,
        ),
      topics: z
        .array(z.string())
        .optional()
        .describe(`Limit to these topics: ${FIX_TOPICS.join(', ')}.`),
      answers: z
        .record(z.string(), z.boolean())
        .optional()
        .describe('For "grade": question id -> your true/false answer.'),
    },
    async ({action, family, topics, answers}) => {
      try {
        if (action === 'pattern') return patternReport(family);
        const unknownTopics = (topics ?? []).filter(
          t => !FIX_TOPICS.includes(t),
        );
        if (unknownTopics.length > 0) {
          return errorResult(
            `unknown topic(s): ${unknownTopics.join(', ')}. Known: ${FIX_TOPICS.join(', ')}.`,
          );
        }
        const qs = questionsFor(topics);
        if (action === 'ask') {
          return toolResult(
            [
              `## Fix knowledge check — ${qs.length} question(s)`,
              '',
              'Answer each true or false, then call again with `action: "grade"` and `answers: {id: true|false}`.',
              '',
              ...qs.map(q => `- \`${q.id}\` (${q.topic}): ${q.statement}`),
            ].join('\n'),
          );
        }

        const given = answers ?? {};
        const byId = new Map(FIX_QUESTIONS.map(q => [q.id, q]));
        const unknownIds = Object.keys(given).filter(id => !byId.has(id));
        if (unknownIds.length > 0) {
          return errorResult(
            `unknown question id(s): ${unknownIds.join(', ')}. Call with action "ask" for the list.`,
          );
        }
        const graded = FIX_QUESTIONS.filter(
          q => qs.includes(q) || q.id in given,
        );
        const wrong = graded.filter(
          q => q.id in given && given[q.id] !== q.answer,
        );
        const right = graded.filter(
          q => q.id in given && given[q.id] === q.answer,
        );
        const missing = graded.filter(q => !(q.id in given));
        const lines: string[] = [
          `## Fix knowledge check — ${right.length} of ${graded.length} correct`,
          '',
        ];
        for (const q of wrong) {
          lines.push(
            `❌ \`${q.id}\`: "${q.statement}" is **${q.answer ? 'true' : 'false'}**. ${q.why} Check: ${q.check}`,
          );
        }
        if (wrong.length > 0) lines.push('');
        if (right.length > 0) {
          lines.push(`✅ correct: ${right.map(q => `\`${q.id}\``).join(', ')}`);
        }
        if (missing.length > 0) {
          lines.push(
            `- not answered: ${missing.map(q => `\`${q.id}\``).join(', ')}`,
          );
        }
        lines.push(
          '',
          wrong.length === 0 && missing.length === 0
            ? 'All answered correctly.'
            : wrong.length > 0
              ? 'Re-check the trace against each wrong answer before writing the fix.'
              : 'Answer the remaining questions before writing the fix.',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

function patternReport(family: string | undefined) {
  const picked =
    family != null && family !== ''
      ? [fixPatternFor(family)].filter(p => p != null)
      : FIX_PATTERNS;
  if (picked.length === 0) {
    return errorResult(
      `unknown family "${family}". Known: ${FIX_PATTERNS.map(p => p.id).join(', ')}.`,
    );
  }
  const byId = new Map(FIX_QUESTIONS.map(q => [q.id, q]));
  const lines: string[] = [];
  for (const p of picked) {
    lines.push(
      `## Fix pattern \`${p.id}\`: ${p.family}`,
      '',
      `**Signal:** ${p.signal}`,
      '',
      '**Fix:**',
      ...p.fix.map(f => `- ${f}`),
      '',
      `**Test:** ${p.test}`,
      '',
      `**Answer first** (\`action: "grade"\`): ${p.questions
        .map(id => `\`${id}\` — ${byId.get(id)?.statement ?? ''}`)
        .join(' ')}`,
      '',
    );
  }
  return toolResult(lines.join('\n'));
}
