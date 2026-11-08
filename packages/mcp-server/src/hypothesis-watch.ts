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
 * Hypotheses kept for a sweep and re-judged on each of its rounds.
 *
 * A hypothesis tested once is a fact about one round. The ones worth keeping
 * ("no extra Window realm", "the listener records stay flat") are the ones
 * whose answer could change in a later round, and noticing that meant
 * re-typing the predicate every round. Stored per sweep (a round's parent
 * directory) under MEMLAB_STATE_DIR, with the last result of each, so a round
 * can say which ones flipped.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export type WatchExpectation = 'grows' | 'flat' | 'absent' | 'present';

export interface WatchedHypothesis {
  label: string;
  predicate: string;
  expect: WatchExpectation;
  /** The latest round judged, and its result (null: undecidable). */
  last?: RoundResult;
  /** The round judged before `last`. */
  previous?: RoundResult;
}

interface RoundResult {
  round: string;
  pass: boolean | null;
}

type Ledger = Record<string, WatchedHypothesis[]>;

const MAX_SWEEPS = 50;

function ledgerFile(): string {
  return path.join(
    process.env.MEMLAB_STATE_DIR ?? path.join(os.homedir(), '.memlab'),
    'hypothesis-watch.json',
  );
}

function sweepOf(runDir: string): string {
  return path.dirname(path.resolve(runDir));
}

function readLedger(): Ledger {
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8')) as unknown;
    return raw != null && typeof raw === 'object' ? (raw as Ledger) : {};
  } catch {
    return {};
  }
}

function writeLedger(ledger: Ledger): void {
  const keys = Object.keys(ledger);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SWEEPS))) {
    delete ledger[k];
  }
  const file = ledgerFile();
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, file);
}

export function watchedFor(runDir: string): WatchedHypothesis[] {
  return readLedger()[sweepOf(runDir)] ?? [];
}

/** One hypothesis's result this round, against the last one recorded. */
export interface WatchOutcome {
  label: string;
  pass: boolean | null;
  before?: RoundResult;
}

/**
 * Record this round's results for the sweep, adding any hypothesis not yet
 * watched, and return each with its previous result. A round already
 * recorded is compared with the round before it, so re-running the battery
 * on one round does not hide a flip.
 */
export function recordWatch(
  runDir: string,
  results: ReadonlyArray<{
    label: string;
    predicate: string;
    expect: WatchExpectation;
    pass: boolean | null;
  }>,
): WatchOutcome[] {
  const ledger = readLedger();
  const sweep = sweepOf(runDir);
  const round = path.basename(path.resolve(runDir));
  const list = ledger[sweep] ?? [];
  const out: WatchOutcome[] = [];
  for (const r of results) {
    let entry = list.find(w => w.label === r.label);
    if (entry == null) {
      entry = {label: r.label, predicate: r.predicate, expect: r.expect};
      list.push(entry);
    }
    entry.predicate = r.predicate;
    entry.expect = r.expect;
    if (entry.last != null && entry.last.round !== round) {
      entry.previous = entry.last;
    }
    const before = entry.previous;
    entry.last = {round, pass: r.pass};
    out.push({label: r.label, pass: r.pass, before});
  }
  ledger[sweep] = list;
  writeLedger(ledger);
  return out;
}

/** Stop watching these labels for the sweep; returns how many were removed. */
export function unwatch(runDir: string, labels: readonly string[]): number {
  const ledger = readLedger();
  const sweep = sweepOf(runDir);
  const list = ledger[sweep] ?? [];
  const kept = list.filter(w => !labels.includes(w.label));
  ledger[sweep] = kept;
  writeLedger(ledger);
  return list.length - kept.length;
}
