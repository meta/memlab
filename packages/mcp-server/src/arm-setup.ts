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
 * Did anything about the setup change under a ladder that a fix check reads?
 *
 * A per-cycle rate is only a rate of the app when every rung of the arm ran
 * the same code in the same V8 isolate, and two arms only compare a fix when
 * they ran the same kind of build in the same browser. The leak-hunt runner
 * records all of that in run.json; this reads it for the rungs an arm actually
 * uses. Snapshots with no run.json next to them are not checked, and say so.
 */

import fs from 'fs';
import path from 'path';

export interface ArmSetup {
  /**
   * The run.json the arm's rungs came from, or null when none was found. When
   * the rungs come from several runs (itself reported as an issue), the first.
   */
  runJson: string | null;
  devBuild: boolean | null;
  browserVersion: string | null;
  /** Changes inside the arm, one sentence each. */
  issues: string[];
  /** Worth saying but not a reason to withhold the verdict. */
  notes: string[];
  /**
   * The cycle count run.json records for each rung of the arm, in order, or
   * null unless every rung has one. The runner's rungs are not evenly spaced
   * (the first ladder rung comes after two batches), so a slope that places
   * rung i at i * cycles is biased.
   */
  cycles: number[] | null;
}

/** run.json next to the rung, or one level up (the runner writes rungs to snapshots/). */
export function findRunJson(rungPath: string): string | null {
  const dir = path.dirname(rungPath);
  for (const candidate of [
    path.join(dir, 'run.json'),
    path.join(path.dirname(dir), 'run.json'),
  ]) {
    if (fs.statSync(candidate, {throwIfNoEntry: false})?.isFile()) {
      return candidate;
    }
  }
  return null;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return raw != null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function readArmSetup(rungPaths: string[]): ArmSetup {
  const files = new Set<string>();
  for (const p of rungPaths) {
    const f = findRunJson(p);
    if (f != null) files.add(f);
  }
  if (files.size === 0) {
    return {
      runJson: null,
      devBuild: null,
      browserVersion: null,
      issues: [],
      notes: [],
      cycles: null,
    };
  }
  if (files.size > 1) {
    return {
      runJson: [...files][0],
      devBuild: null,
      browserVersion: null,
      issues: [
        `its rungs come from ${files.size} different runs (${[...files].join(', ')}), so the slope mixes sessions`,
      ],
      notes: [],
      cycles: null,
    };
  }
  const runJson = [...files][0];
  const raw = readJson(runJson);
  if (raw == null) {
    return {
      runJson,
      devBuild: null,
      browserVersion: null,
      issues: [`${runJson} is not readable JSON`],
      notes: [],
      cycles: null,
    };
  }

  const env = (raw.environment ?? {}) as Record<string, unknown>;
  const devBuild = typeof env.dev_build === 'boolean' ? env.dev_build : null;
  const browserVersion =
    typeof env.browser_version === 'string' ? env.browser_version : null;

  type RungRecord = {
    index: number;
    restarted: boolean;
    cycles: number | null;
  };
  const byName = new Map<string, RungRecord>();
  const duplicated = new Set<string>();
  for (const r of Array.isArray(raw.rungs) ? raw.rungs : []) {
    const o = r as {
      index?: unknown;
      path?: unknown;
      isolate_restarted?: unknown;
      cycles?: unknown;
    };
    if (typeof o.index !== 'number' || typeof o.path !== 'string') continue;
    const name = path.basename(o.path);
    if (byName.has(name)) {
      duplicated.add(name);
      continue;
    }
    byName.set(name, {
      index: o.index,
      restarted: o.isolate_restarted === true,
      cycles: typeof o.cycles === 'number' ? o.cycles : null,
    });
  }
  const usable = rungPaths.filter(p => !duplicated.has(path.basename(p)));
  const used = usable
    .map(p => byName.get(path.basename(p)))
    .filter((r): r is RungRecord => r != null);
  const cycles =
    used.length === rungPaths.length && used.every(r => r.cycles != null)
      ? used.map(r => r.cycles as number)
      : null;
  const issues: string[] = [];
  const notes: string[] = [];
  const unmatched = rungPaths.length - used.length;
  if (unmatched > 0) {
    notes.push(
      `${unmatched} of its ${rungPaths.length} rungs are not listed (or listed twice) in ${runJson}, so the setup check does not cover them and the arm is placed every \`cycles\` cycles`,
    );
  }
  if (used.length < 2) {
    return {runJson, devBuild, browserVersion, issues, notes, cycles};
  }
  const first = Math.min(...used.map(r => r.index));
  const last = Math.max(...used.map(r => r.index));

  for (const r of used.filter(u => u.index !== first)) {
    if (r.restarted) {
      issues.push(
        `the V8 isolate restarted at rung ${r.index} (the page reloaded), so the rungs on either side are different heaps`,
      );
    }
  }
  const splits = Array.isArray(raw.ladder_splits_after_rung)
    ? raw.ladder_splits_after_rung
    : [];
  for (const s of splits) {
    if (typeof s === 'number' && s >= first && s < last) {
      issues.push(`the runner detected a ladder split after rung ${s}`);
    }
  }

  // Each used rung ran the revision recorded last at or before it: the
  // runner records one at bring-up and at every rung, but a run.json written
  // another way may record only the changes.
  const recorded: Array<{at: number; rev: string}> = [];
  for (const e of Array.isArray(raw.served_revisions)
    ? raw.served_revisions
    : []) {
    const o = e as {at?: unknown; rev?: unknown};
    if (typeof o.at !== 'string' || typeof o.rev !== 'string') continue;
    const m = /^rung (\d+)$/.exec(o.at);
    const at = o.at === 'bring-up' ? -1 : m ? Number(m[1]) : null;
    if (at != null) recorded.push({at, rev: o.rev.split(' ')[0]});
  }
  recorded.sort((x, y) => x.at - y.at);
  const revs: string[] = [];
  for (const u of [...used].sort((x, y) => x.index - y.index)) {
    const rev = recorded.filter(r => r.at <= u.index).pop()?.rev;
    if (rev != null && revs[revs.length - 1] !== rev) revs.push(rev);
  }
  if (new Set(revs).size > 1) {
    // The runner records the checkout's revision for every round, but only a
    // preset app or an --ab-patch arm is known to be served from it.
    const ab = raw.ab as {patch?: unknown} | null | undefined;
    const served =
      (typeof raw.app === 'string' && raw.app !== '') || ab?.patch != null;
    if (served) {
      issues.push(
        `the served checkout changed between its rungs (${revs.join(' → ')}), so they ran different code`,
      );
    } else {
      notes.push(
        `the checkout the runner watches changed between its rungs (${revs.join(' → ')}); the round names no app preset, so if this app is not served from that checkout it did not change the code under test`,
      );
    }
  }
  return {runJson, devBuild, browserVersion, issues, notes, cycles};
}

/** Differences between two arms that make their rates incomparable. */
export function compareArmSetups(
  a: ArmSetup,
  b: ArmSetup,
  aName: string,
  bName: string,
): string[] {
  const out: string[] = [];
  if (a.devBuild != null && b.devBuild != null && a.devBuild !== b.devBuild) {
    const kind = (dev: boolean) =>
      dev ? 'a dev build' : 'a production-like build';
    out.push(
      `the ${aName} arm measured ${kind(a.devBuild)} and the ${bName} arm ${kind(b.devBuild)}`,
    );
  }
  if (
    a.browserVersion != null &&
    b.browserVersion != null &&
    a.browserVersion !== b.browserVersion
  ) {
    out.push(
      `the ${aName} arm ran in ${a.browserVersion} and the ${bName} arm in ${b.browserVersion}`,
    );
  }
  return out;
}
