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
import os from 'os';
import path from 'path';

import {getSnapshotMetadata} from './heap-state.js';
import {lastSnapshotReadInScope, noteRoundPath} from './read-scope.js';
import {SERVER_VERSION} from './server-version.js';

/**
 * Machine-readable records of a session, for a program that wraps the server
 * and keeps what each tool concluded.
 *
 * Off unless `MEMLAB_RECORD_FILE` names a file (`memlab-cli --record <file>`
 * sets it). Then each recording tool appends one JSON line to that file, and
 * every tool call appends a `tool_call` line with its duration and whether it
 * failed. The tool's answer is the same either way, so a session that does not
 * ask for records sees no difference at all.
 *
 * Each record names the round it belongs to: the directory of the snapshot
 * ladder the call read, as a hash of host and path, plus the directory's name
 * and the `app` and `combos` of its `run.json`. A wrapper groups records into
 * rounds by that hash.
 *
 * A record holds verdicts, counts, class names and that round summary. It
 * never holds snapshot paths, string contents or the answer text.
 */

/** Bumped when a field changes meaning or goes away; new fields keep it. */
export const RECORD_CONTRACT_VERSION = 1;

export type RecordKind =
  | 'round_audit'
  | 'leak_report'
  | 'verify_fix'
  | 'finding_check'
  | 'optimization'
  | 'tool_call';

export interface RecordRound {
  key: string;
  label: string | null;
  app: string | null;
  combos: string[];
}

export interface SessionRecord {
  contract: number;
  tool: string;
  kind: RecordKind;
  at: string;
  server_version: string;
  round?: RecordRound;
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
  const round = currentRound();
  const record: SessionRecord = {
    contract: RECORD_CONTRACT_VERSION,
    tool,
    kind,
    at: new Date().toISOString(),
    server_version: SERVER_VERSION,
    ...(round != null ? {round} : {}),
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

/**
 * Run one tool call and, when recording is on, append its `tool_call` record.
 * A call that throws (a timeout, say) is recorded as an error and rethrown.
 * The round its parameters name counts as read, so a tool that loads rungs
 * without noting them still names its round; files it reads take precedence.
 */
export async function withToolCallRecord<T>(
  tool: string,
  params: unknown,
  call: () => Promise<T>,
): Promise<T> {
  if (recordFile() == null) {
    return call();
  }
  const pointed = roundPathOfParams(params);
  if (pointed != null) {
    noteRoundPath(pointed);
  }
  const started = Date.now();
  let isError = true;
  try {
    const result = await call();
    isError = (result as {isError?: unknown} | null)?.isError === true;
    return result;
  } finally {
    noteRecord(tool, 'tool_call', {
      ms: Date.now() - started,
      is_error: isError,
    });
  }
}

/**
 * The file a call's parameters point at: its round's `run.json` for `run_dir`,
 * else the last of `after_paths` or `paths`, else `file_path`.
 */
function roundPathOfParams(params: unknown): string | null {
  if (params == null || typeof params !== 'object') {
    return null;
  }
  const {run_dir, after_paths, paths, file_path} = params as Record<
    string,
    unknown
  >;
  if (typeof run_dir === 'string' && run_dir !== '') {
    return run_dir.endsWith('.json') ? run_dir : path.join(run_dir, 'run.json');
  }
  for (const list of [after_paths, paths]) {
    const last = Array.isArray(list) ? list.at(-1) : undefined;
    if (typeof last === 'string' && last !== '') {
      return last;
    }
  }
  return typeof file_path === 'string' && file_path !== '' ? file_path : null;
}

/** A rung's round: its directory, or the one above a `snapshots/` directory. */
export function roundDirOf(filePath: string): string {
  const dir = path.dirname(path.resolve(filePath));
  return path.basename(dir) === 'snapshots' ? path.dirname(dir) : dir;
}

const MAX_LABEL_CHARS = 64;
const MAX_COMBO_CHARS = 128;
const MAX_COMBOS = 20;

function cleanName(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const name = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, maxChars);
  return name === '' ? null : name;
}

interface RoundManifest {
  mtimeMs: number;
  app: string | null;
  combos: string[];
}

const manifests = new Map<string, RoundManifest>();

/** `app` and `combos` from the round's `run.json`, re-read when it changes. */
function readManifest(dir: string): Omit<RoundManifest, 'mtimeMs'> {
  const file = path.join(dir, 'run.json');
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return {app: null, combos: []};
  }
  const cached = manifests.get(dir);
  if (cached != null && cached.mtimeMs === mtimeMs) {
    return cached;
  }
  let app: string | null = null;
  let combos: string[] = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      app?: unknown;
      combos?: unknown;
    };
    app = cleanName(manifest.app, MAX_LABEL_CHARS);
    if (Array.isArray(manifest.combos)) {
      combos = manifest.combos
        .map(combo => cleanName(combo, MAX_COMBO_CHARS))
        .filter((combo): combo is string => combo != null)
        .slice(0, MAX_COMBOS);
    }
  } catch {
    // An unreadable or half-written manifest leaves the round unnamed.
  }
  const entry = {mtimeMs, app, combos};
  manifests.set(dir, entry);
  return entry;
}

export function roundOf(dir: string): RecordRound {
  const key = createHash('sha256')
    .update(`${os.hostname()}\0${dir}`)
    .digest('hex')
    .slice(0, 16);
  const {app, combos} = readManifest(dir);
  return {
    key,
    label: cleanName(path.basename(dir), MAX_LABEL_CHARS),
    app,
    combos,
  };
}

/**
 * The round of the snapshot the current call read last, else of the resident
 * snapshot; none when the call touched no snapshot.
 */
function currentRound(): RecordRound | undefined {
  const file =
    lastSnapshotReadInScope() ?? getSnapshotMetadata()?.filePath ?? null;
  return file == null ? undefined : roundOf(roundDirOf(file));
}
