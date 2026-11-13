/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {exec} from 'child_process';

/**
 * Live status of a fix diff, read with the operator's `MEMLAB_FIX_STATUS_CMD`
 * (a shell command with `{diff}` in it whose first output line is shown).
 *
 * A failed lookup says WHY (timeout, exit code, first stderr line): a bare
 * "lookup failed" on every call left no way to tell a misconfigured command
 * from a slow one. Successful answers are cached per diff for a few minutes,
 * since a round reconfirms the same findings many times.
 */

const DEFAULT_TIMEOUT_MS = 20000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, {line: string; at: number}>();

export type FixStatusOutcome = {
  diff: string;
  ok: boolean;
  detail: string;
  at: number;
};

let lastOutcome: FixStatusOutcome | null = null;

/** The most recent lookup in this process, for `memlab_server_status`. */
export function lastFixStatusOutcome(): FixStatusOutcome | null {
  return lastOutcome;
}

/** Only identifiers reach the shell. */
export function isDiffId(diff: string): boolean {
  return /^[A-Za-z]{0,4}\d+$/.test(diff);
}

export function fixStatusCommand(): string | null {
  const template = process.env.MEMLAB_FIX_STATUS_CMD;
  return template == null || template === '' ? null : template;
}

function lookupTimeoutMs(): number {
  const raw = Number(process.env.MEMLAB_FIX_STATUS_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/** Why a lookup failed, in one short clause. */
export function describeLookupFailure(
  err: {code?: unknown; signal?: unknown; killed?: boolean} & Error,
  stderr: string,
  timeoutMs: number,
): string {
  const parts: string[] = [];
  // `killed` is set only when exec's own timeout killed the child; a
  // SIGTERM from elsewhere is reported as a signal below.
  if (err.killed === true) {
    parts.push(`timed out after ${Math.round(timeoutMs / 1000)}s`);
  } else if (typeof err.code === 'number') {
    parts.push(`exit ${err.code}`);
  } else if (typeof err.code === 'string') {
    parts.push(err.code);
  } else if (err.signal != null) {
    parts.push(`killed by ${String(err.signal)}`);
  }
  const firstErr = stderr
    .split('\n')
    .map(l => l.trim())
    .find(l => l !== '');
  if (firstErr != null) parts.push(firstErr.slice(0, 160));
  else if (parts.length === 0) parts.push(err.message.slice(0, 160));
  return parts.join(': ');
}

/**
 * One line per diff: `- Fix status of D1: <first output line>`, or the reason
 * the lookup failed. Diffs are looked up in parallel and off the event loop;
 * only identifiers reach the shell.
 */
export async function fixStatusLinesFor(
  diffs: readonly string[],
): Promise<string[]> {
  const template = fixStatusCommand();
  if (template == null) return [];
  if (!template.includes('{diff}')) {
    // A mangled template runs the same wrong command for every diff, and
    // its error says nothing about the cause.
    const detail = `MEMLAB_FIX_STATUS_CMD has no {diff} placeholder: \`${template.slice(0, 120)}\``;
    lastOutcome = {diff: diffs[0] ?? '', ok: false, detail, at: Date.now()};
    return diffs.length > 0 ? [`- Fix status not looked up: ${detail}`] : [];
  }
  const timeoutMs = lookupTimeoutMs();
  const lines = await Promise.all(
    diffs.filter(isDiffId).map(
      diff =>
        new Promise<string | null>(resolve => {
          const hit = cache.get(diff);
          if (hit != null && Date.now() - hit.at < CACHE_TTL_MS) {
            resolve(hit.line);
            return;
          }
          exec(
            template.split('{diff}').join(diff),
            {timeout: timeoutMs},
            (err, stdout, stderr) => {
              const at = Date.now();
              if (err != null) {
                const detail = describeLookupFailure(
                  err,
                  String(stderr),
                  timeoutMs,
                );
                lastOutcome = {diff, ok: false, detail, at};
                resolve(`- Fix status of ${diff}: (lookup failed: ${detail})`);
                return;
              }
              const out = String(stdout).trim().split('\n')[0]?.slice(0, 200);
              lastOutcome = {diff, ok: true, detail: out ?? '', at};
              const line = out ? `- Fix status of ${diff}: ${out}` : null;
              if (line != null) cache.set(diff, {line, at});
              resolve(line);
            },
          );
        }),
    ),
  );
  return lines.filter((l): l is string => l != null);
}
