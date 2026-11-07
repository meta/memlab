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
 * Does a finding write-up carry the evidence its claim needs?
 *
 * Findings have been filed, and later withdrawn, on a single run, on a dev
 * build, on a population that was still draining, or on a fix nobody measured.
 * Each was a check that was skipped while the write-up still read as complete.
 * This makes every check an explicit entry with a status, and refuses a claim
 * whose required checks were not actually measured. It validates what the
 * write-up declares; it does not re-run the measurements.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'fs';
import {z} from 'zod';
import {errorResult, toolResult} from '../utils.js';

const STATUSES = ['measured', 'unavailable', 'not_applicable', 'blocked'];

/** Every finding declares these. */
export const FINDING_CHECKS: Record<string, string> = {
  reproduced:
    'the effect reproduces across independently driven runs (memlab_replicate)',
  at_rest:
    'the population survives at rest, not in-flight work (memlab_settle_check)',
  production_like:
    'it is present on a production-like build, not only a dev build (memlab_dev_artifacts)',
  retainer_path: 'the retainer path from a GC root (memlab_retainer_trace)',
  per_cycle_rate:
    'its growth per interaction cycle (memlab_ladder_probe / memlab_rate_model)',
  not_known_artifact:
    'it is not a known or already-fixed finding or a measurement artifact (memlab_finding_index)',
};

/** Checks a claim cannot rest on unless they were measured. */
const MUST_MEASURE: Record<string, string[]> = {
  leak: ['reproduced', 'at_rest', 'retainer_path', 'per_cycle_rate'],
  fixed: [
    'reproduced',
    'at_rest',
    'retainer_path',
    'per_cycle_rate',
    'fix_verdict',
  ],
  not_a_leak: [],
};

export function validateFinding(finding: unknown): string[] {
  const problems: string[] = [];
  const f = (finding ?? {}) as {
    claim?: unknown;
    checks?: unknown;
  };
  const claim = typeof f.claim === 'string' ? f.claim : '';
  // The per-claim rules below say nothing useful about an unknown claim.
  const knownClaim = Object.prototype.hasOwnProperty.call(MUST_MEASURE, claim);
  if (!knownClaim) {
    problems.push(
      `\`claim\` must be one of ${Object.keys(MUST_MEASURE).join(', ')} (got ${JSON.stringify(f.claim ?? null)}).`,
    );
  }
  const checks =
    f.checks != null && typeof f.checks === 'object'
      ? (f.checks as Record<string, unknown>)
      : {};
  const required = [
    ...Object.keys(FINDING_CHECKS),
    ...(claim === 'fixed' ? ['fix_verdict'] : []),
  ];
  for (const id of required) {
    const c = checks[id] as
      | {
          status?: unknown;
          evidence?: unknown;
          result?: unknown;
          reason?: unknown;
        }
      | undefined;
    if (c == null || typeof c !== 'object') {
      problems.push(`\`checks.${id}\` is missing.`);
      continue;
    }
    const status = typeof c.status === 'string' ? c.status : '';
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    if (!STATUSES.includes(status)) {
      problems.push(
        `\`checks.${id}.status\` must be one of ${STATUSES.join(', ')}.`,
      );
      continue;
    }
    const mustMeasure = knownClaim && MUST_MEASURE[claim].includes(id);
    if (status === 'measured') {
      if (text(c.evidence) === '') {
        problems.push(
          `\`checks.${id}\` is measured but has no \`evidence\` (the tool call, run directory or snapshot it rests on).`,
        );
      }
      if (text(c.result) === '') {
        problems.push(`\`checks.${id}\` is measured but has no \`result\`.`);
      }
    } else if (text(c.reason) === '' && !mustMeasure) {
      problems.push(
        `\`checks.${id}\` is ${status} but gives no \`reason\`. Missing instrumentation or a convincing hypothesis is not a reason to skip a check.`,
      );
    }
    if (mustMeasure && status !== 'measured') {
      problems.push(
        `a \`${claim}\` claim needs \`checks.${id}\` measured, not ${status}.`,
      );
    }
    if (
      knownClaim &&
      id === 'production_like' &&
      claim !== 'not_a_leak' &&
      status !== 'measured' &&
      status !== 'not_applicable'
    ) {
      problems.push(
        `a \`${claim}\` claim needs \`checks.production_like\` measured, or not_applicable with a reason (an app with no separate dev build).`,
      );
    }
  }
  if (claim === 'fixed') {
    const fv = checks.fix_verdict as
      {status?: unknown; result?: unknown} | undefined;
    if (
      fv?.status === 'measured' &&
      typeof fv.result === 'string' &&
      !/FIX CONFIRMED/i.test(fv.result)
    ) {
      problems.push(
        '`checks.fix_verdict.result` does not say FIX CONFIRMED; a `fixed` claim rests on a confirmed memlab_verify_fix verdict.',
      );
    }
  }
  return problems;
}

export function registerValidateFinding(server: McpServer): void {
  server.tool(
    'memlab_validate_finding',
    'Check a finding write-up against the evidence its claim needs, BEFORE it is filed. The finding is JSON: `claim` ("leak", "fixed" or "not_a_leak") and `checks`, one entry per check with `status` ("measured", "unavailable", "not_applicable" or "blocked"); a measured check gives `evidence` (the tool call, run directory or snapshot) and `result`, any other status gives a `reason`. ' +
      `Every finding declares: ${Object.entries(FINDING_CHECKS)
        .map(([id, what]) => `\`${id}\` (${what})`)
        .join(
          '; ',
        )}; a "fixed" claim also declares \`fix_verdict\`, whose result must say FIX CONFIRMED. ` +
      'A "leak" or "fixed" claim needs reproduced, at_rest, retainer_path and per_cycle_rate MEASURED, and production_like measured or not applicable with a reason. An empty query result is unavailable, not a negative. ' +
      'Returns VALID or INVALID with each problem. It checks what the write-up declares, not whether the measurements are right. Pass the finding inline (`finding`) or as a file (`path`).',
    {
      finding: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('The finding as a JSON object.'),
      path: z
        .string()
        .optional()
        .describe('A JSON file holding the finding, instead of `finding`.'),
    },
    async ({finding, path}) => {
      try {
        if ((finding == null) === (path == null)) {
          return errorResult('Pass exactly one of `finding` or `path`.');
        }
        const value: unknown =
          finding ?? JSON.parse(fs.readFileSync(path as string, 'utf8'));
        const problems = validateFinding(value);
        const title =
          typeof (value as {title?: unknown})?.title === 'string'
            ? ` — ${(value as {title: string}).title}`
            : '';
        return toolResult(
          problems.length === 0
            ? `## Finding check${title}\n\n✅ **VALID** — every required check is declared with its evidence or reason, and the claim's required checks were measured. This checks declarations, not the numbers behind them.`
            : [
                `## Finding check${title}`,
                '',
                `❌ **INVALID** — ${problems.length} problem(s):`,
                '',
                ...problems.map(p => `- ${p}`),
              ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
