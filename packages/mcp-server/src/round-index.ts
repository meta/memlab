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
 * The shared round index: one directory per finished round,
 * `<root>/<app>/<round>/`, holding a `summary.json` and copies of the round's
 * small files (run.json, round.done, samples, analysis output). Snapshots are
 * not copied. With `$HOME` shared across hosts, a round run on one machine can
 * be digested and compared from another, where its run directory does not
 * exist.
 *
 * The leak-hunt runner publishes a round when it ends; `memlab_analysis_battery`
 * refreshes the copy of its analysis when the round is already indexed.
 */

export interface RoundSummary {
  round: string;
  app: string;
  /** Host the round ran on. */
  host?: string;
  /** The round's run directory on that host. */
  run_dir: string;
  published_at?: string;
  [key: string]: unknown;
}

export interface IndexedRound {
  app: string;
  round: string;
  dir: string;
  summary: RoundSummary | null;
}

/** Files at most this large are copied into the index. */
export const INDEX_MAX_FILE_BYTES = 5 * 1024 * 1024;
const COPIED = /\.(json|jsonl|txt|md)$|^round\.done$/i;
// Copied whatever their size: without run.json a round is not found at all.
const ALWAYS_COPIED = new Set(['run.json', 'round.done']);

export function roundIndexRoot(): string {
  // `||`, not `??`: an empty value means the default, as in the publisher.
  return (
    process.env.MEMLAB_ROUND_INDEX ||
    path.join(os.homedir(), '.memlab-mcp', 'rounds')
  );
}

function readSummary(dir: string): RoundSummary | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'),
    ) as RoundSummary;
  } catch {
    return null;
  }
}

function listDirs(dir: string): string[] {
  try {
    return (
      fs
        .readdirSync(dir, {withFileTypes: true})
        // A dot entry is a publish still being staged.
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(d => d.name)
    );
  } catch {
    return [];
  }
}

/** Every indexed round, or those named `name` (`r425` or `<app>/r425`). */
export function indexedRounds(name?: string): IndexedRound[] {
  const root = roundIndexRoot();
  const [app, round] =
    name != null && name.includes('/') ? name.split('/', 2) : [null, name];
  const out: IndexedRound[] = [];
  for (const a of app != null ? [app] : listDirs(root)) {
    for (const r of round != null ? [round] : listDirs(path.join(root, a))) {
      const dir = path.join(root, a, r);
      if (r.startsWith('.') || !fs.existsSync(path.join(dir, 'run.json'))) {
        continue;
      }
      out.push({app: a, round: r, dir, summary: readSummary(dir)});
    }
  }
  return out;
}

const ROUND_NAME = /^[\w.-]+(\/[\w.-]+)?$/;

/**
 * A run directory, or a round name looked up in the index. A path that exists
 * wins, so a local round is read where it was written.
 */
export function resolveRoundDir(ref: string): string {
  if (fs.existsSync(ref) || !ROUND_NAME.test(ref)) return ref;
  const hits = indexedRounds(ref);
  if (hits.length === 1) return hits[0].dir;
  if (hits.length === 0) {
    throw new Error(
      `"${ref}" is not a path, and no round of that name is in the round index (${roundIndexRoot()}).`,
    );
  }
  throw new Error(
    `"${ref}" names ${hits.length} indexed rounds; pass one of: ${hits.map(h => `${h.app}/${h.round}`).join(', ')}.`,
  );
}

/**
 * For an index entry, the run directory the round was published from and its
 * host: where a tool that needs the snapshots has to run. Null otherwise.
 */
export function publishedFrom(
  dir: string,
): {runDir: string; host: string | null} | null {
  const root = roundIndexRoot();
  if (!path.resolve(dir).startsWith(path.resolve(root) + path.sep)) {
    return null;
  }
  const s = readSummary(dir);
  return s == null ? null : {runDir: s.run_dir, host: s.host ?? null};
}

/** The line a tool prints when it read a round from the index. */
export function indexProvenance(dir: string): string | null {
  const root = roundIndexRoot();
  if (!path.resolve(dir).startsWith(path.resolve(root) + path.sep)) {
    return null;
  }
  const s = readSummary(dir);
  return `_Read from the round index (${dir})${s != null ? `: ${s.app}/${s.round}, run on ${s.host ?? 'an unknown host'} in ${s.run_dir}` : ''}._`;
}

function copySmallFiles(from: string, to: string): number {
  let copied = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(from, {withFileTypes: true});
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isFile() || !COPIED.test(e.name)) continue;
    const src = path.join(from, e.name);
    if (
      fs.statSync(src).size > INDEX_MAX_FILE_BYTES &&
      !ALWAYS_COPIED.has(e.name)
    ) {
      continue;
    }
    fs.mkdirSync(to, {recursive: true});
    fs.copyFileSync(src, path.join(to, e.name));
    copied++;
  }
  return copied;
}

/**
 * Copy a round's analysis output into its index entry, when the round is
 * indexed from this run directory. Returns the entry, or null.
 */
export function refreshIndexedRound(runDir: string): string | null {
  const real = path.resolve(runDir.replace(/\/$/, ''));
  const entry = indexedRounds(path.basename(real)).find(
    r => r.summary != null && path.resolve(r.summary.run_dir) === real,
  );
  if (entry == null) return null;
  copySmallFiles(real, entry.dir);
  copySmallFiles(path.join(real, 'analysis'), path.join(entry.dir, 'analysis'));
  return entry.dir;
}
