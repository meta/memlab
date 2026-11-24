/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {createHash} from 'crypto';
import fs from 'fs';

/**
 * Machine-readable records of a session, for a program that wraps the server
 * and keeps what each tool concluded.
 *
 * Off unless `MEMLAB_RECORD_FILE` names a file (`memlab-cli --record <file>`
 * sets it). Then each recording tool appends one JSON line to that file. The
 * tool's answer is the same either way, so a session that does not ask for
 * records sees no difference at all.
 *
 * A record holds verdicts, counts and class names. It never holds snapshot
 * paths, string contents or the answer text.
 */

/** Bumped when a field changes meaning or goes away; new fields keep it. */
export const RECORD_CONTRACT_VERSION = 1;

export type RecordKind =
  | 'round_audit'
  | 'leak_report'
  | 'verify_fix'
  | 'finding_check'
  | 'optimization';

export interface SessionRecord {
  contract: number;
  tool: string;
  kind: RecordKind;
  at: string;
  data: Record<string, unknown>;
}

export function recordFile(): string | null {
  const file = process.env.MEMLAB_RECORD_FILE;
  return file != null && file !== '' ? file : null;
}

/**
 * Append one record when recording is on. Never throws: a record that cannot
 * be written is reported on stderr, and the wrapper, which knows which tools
 * it called, treats the missing line as a failed session.
 */
export function noteRecord(
  tool: string,
  kind: RecordKind,
  data: Record<string, unknown>,
): void {
  const file = recordFile();
  if (file == null) {
    return;
  }
  const record: SessionRecord = {
    contract: RECORD_CONTRACT_VERSION,
    tool,
    kind,
    at: new Date().toISOString(),
    data,
  };
  try {
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
  } catch (err) {
    console.error(
      `memlab: could not write the ${tool} record to ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * A heap class name fit for a record. For a string-typed node the "name" is the
 * string's content, which a record must not carry, so it becomes a short hash:
 * still the same label across sessions, so two runs can be matched on it.
 */
export function recordLabel(name: string, type: string): string {
  if (/string/i.test(type)) {
    const hash = createHash('sha256').update(name).digest('hex').slice(0, 12);
    return `(string ${hash})`;
  }
  return name.length > 200 ? `${name.slice(0, 199)}…` : name;
}
