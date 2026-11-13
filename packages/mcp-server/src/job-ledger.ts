/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Background jobs and batteries, recorded on disk.
 *
 * Their handles live in the server's memory, so a restarted server (an MCP
 * reconnect, a plugin update, a crash) answered "no job X in this server
 * process" for work that had finished and written its output. The ledger
 * keeps one small JSON file per handle — and, for a job, its result text — so
 * a status call in a NEW process can still return the result, or say that the
 * process running it died first.
 */

export interface LedgerEntry {
  id: string;
  kind: 'job' | 'battery';
  tool: string;
  pid: number;
  started_at: string;
  status: 'running' | 'done' | 'error';
  finished_at?: string;
  /** A battery's output directory. */
  out_dir?: string;
  /** A job's result text, once finished. */
  result_file?: string;
  /** The latest few progress notes, written as they happen. */
  notes?: string[];
}

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const NOTE_WRITE_INTERVAL_MS = 5000;

export function ledgerDir(): string {
  const base =
    process.env.MEMLAB_STATE_DIR ?? path.join(os.homedir(), '.memlab');
  return path.join(base, 'jobs');
}

function entryPath(id: string): string {
  return path.join(ledgerDir(), `${id.replace(/[^\w.-]/g, '_')}.json`);
}

let pruned = false;

/** Drop entries older than a week, once per process. */
function pruneOnce(): void {
  if (pruned) return;
  pruned = true;
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(ledgerDir())) {
      const p = path.join(ledgerDir(), f);
      try {
        if (now - fs.statSync(p).mtimeMs > MAX_AGE_MS) fs.rmSync(p);
      } catch {
        // Raced with another process; nothing to do.
      }
    }
  } catch {
    // No directory yet.
  }
}

/** Best effort: a ledger that cannot be written never fails the work. */
export function writeLedger(entry: LedgerEntry): void {
  try {
    fs.mkdirSync(ledgerDir(), {recursive: true});
    pruneOnce();
    const p = entryPath(entry.id);
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
    fs.renameSync(tmp, p);
  } catch {
    // Ignored on purpose.
  }
}

/** Store a finished job's result text next to its entry; the file path. */
export function writeLedgerResult(id: string, text: string): string | null {
  try {
    fs.mkdirSync(ledgerDir(), {recursive: true});
    const p = entryPath(id).replace(/\.json$/, '.md');
    const body =
      text.length > MAX_RESULT_BYTES
        ? `${text.slice(0, MAX_RESULT_BYTES)}\n\n_(truncated at ${MAX_RESULT_BYTES} bytes)_`
        : text;
    fs.writeFileSync(p, body, 'utf8');
    return p;
  } catch {
    return null;
  }
}

export function readLedger(id: string): LedgerEntry | null {
  try {
    return JSON.parse(fs.readFileSync(entryPath(id), 'utf8')) as LedgerEntry;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM: it exists but belongs to someone else.
    return (err as {code?: string})?.code === 'EPERM';
  }
}

/**
 * Records progress notes on the entry, at most every few seconds, so a status
 * call after a crash can say how far the work got.
 */
export function ledgerNoteWriter(
  entry: LedgerEntry,
): (notes: readonly string[]) => void {
  let last = 0;
  return notes => {
    const now = Date.now();
    if (now - last < NOTE_WRITE_INTERVAL_MS) return;
    last = now;
    writeLedger({...entry, notes: notes.slice(-8)});
  };
}

/**
 * A status answer for a handle this process does not hold, or null when the
 * ledger has never seen it either.
 */
export function describeForeignEntry(
  entry: LedgerEntry,
  readResult: (entry: LedgerEntry) => string | null,
): {text: string; isError: boolean} {
  const who = `server process ${entry.pid}`;
  if (entry.status !== 'running') {
    const result = readResult(entry);
    if (result != null) {
      return {
        text:
          `_(\`${entry.id}\` ran in ${who}, which is not this one; this is its recorded result, finished ${entry.finished_at ?? 'at an unrecorded time'}.)_\n\n` +
          result,
        isError: entry.status === 'error',
      };
    }
    return {
      text: `\`${entry.id}\` (\`${entry.tool}\`) finished as **${entry.status}** in ${who}, but its result could not be read back.`,
      isError: true,
    };
  }
  const notes =
    entry.notes != null && entry.notes.length > 0
      ? `\n\nLast progress notes:\n${entry.notes.map(n => `- ${n}`).join('\n')}`
      : '';
  if (pidAlive(entry.pid)) {
    return {
      text:
        `\`${entry.id}\` (\`${entry.tool}\`) is still RUNNING in another memlab server, ${who}. ` +
        'Its status is answered by that server; this one can only see the ledger.' +
        notes,
      isError: false,
    };
  }
  return {
    text:
      `\`${entry.id}\` (\`${entry.tool}\`) is ORPHANED: ${who} exited before it finished (started ${entry.started_at}). ` +
      'Start it again.' +
      notes,
    isError: true,
  };
}
