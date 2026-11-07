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
 * The run-to-run noise floor of each setup, so a repeat ladder is paid for once.
 *
 * `memlab_verify_fix` with `before_repeat_paths` measures how far two ladders of the SAME
 * build land apart. That spread belongs to the setup (the app, its build mode,
 * the browser and the machine), not to one fix, so it is recorded under a
 * caller-chosen setup name plus the metric, and later fix checks on that setup
 * reuse it instead of driving another unfixed ladder.
 *
 * The spread is stored relative to the before-arm rate it was measured
 * against, so it carries over to a population that grows faster or slower on
 * the next round. Entries older than NOISE_FLOOR_MAX_AGE_DAYS are not reused.
 */

import fs from 'fs';
import path from 'path';
import {withFileLock} from './judge-ledger.js';

export const NOISE_FLOOR_MAX_AGE_DAYS = 14;

export interface NoiseFloor {
  setup: string;
  metric_kind: string;
  locator: string;
  /** |repeat slope - before slope| / before slope, at the time of recording. */
  relative_spread: number;
  /** ISO timestamp of the check that recorded it. */
  recorded_at: string;
}

interface NoiseLedgerFile {
  floors: Record<string, NoiseFloor>;
}

export function noiseLedgerPath(): string {
  const override = process.env.MEMLAB_NOISE_LEDGER;
  if (override != null && override !== '') return override;
  return path.join(
    process.env.HOME ?? '/tmp',
    '.memlab-mcp',
    'noise-floor.json',
  );
}

function key(setup: string, metricKind: string, locator: string): string {
  return JSON.stringify([setup, metricKind, locator]);
}

function isNoiseFloor(x: unknown): x is NoiseFloor {
  const o = x as NoiseFloor | null;
  return (
    o != null &&
    typeof o.setup === 'string' &&
    typeof o.metric_kind === 'string' &&
    typeof o.locator === 'string' &&
    typeof o.relative_spread === 'number' &&
    Number.isFinite(o.relative_spread) &&
    o.relative_spread >= 0 &&
    typeof o.recorded_at === 'string' &&
    Number.isFinite(Date.parse(o.recorded_at))
  );
}

/** `strict` throws on an unreadable file so a write never replaces it. */
function load(strict: boolean): NoiseLedgerFile {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(noiseLedgerPath(), 'utf8'));
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (strict && !missing) {
      throw new Error(
        `${noiseLedgerPath()} exists but is unreadable (${String(err)}); not overwriting it`,
      );
    }
    return {floors: {}};
  }
  const floors: NoiseLedgerFile['floors'] = {};
  const src = (raw as {floors?: unknown})?.floors;
  if (src == null || typeof src !== 'object') return {floors};
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    if (isNoiseFloor(v)) floors[k] = v;
  }
  return {floors};
}

/** The setup's floor for this metric, or null when none is recorded or it is stale. */
export function readNoiseFloor(
  setup: string,
  metricKind: string,
  locator: string,
  now: number = Date.now(),
): NoiseFloor | null {
  const floor = load(false).floors[key(setup, metricKind, locator)];
  if (floor == null) return null;
  const at = Date.parse(floor.recorded_at);
  if (!Number.isFinite(at)) return null;
  if (now - at > NOISE_FLOOR_MAX_AGE_DAYS * 24 * 3600 * 1000) return null;
  return floor;
}

/** Null when recorded; otherwise why not. The latest check replaces the setup's entry. */
export async function recordNoiseFloor(
  floor: NoiseFloor,
): Promise<string | null> {
  let writeError: string | null = null;
  let locked: boolean;
  try {
    locked = await withFileLock(noiseLedgerPath(), () => {
      const ledger = load(true);
      ledger.floors[key(floor.setup, floor.metric_kind, floor.locator)] = floor;
      const file = noiseLedgerPath();
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        // Write-then-rename keeps every write atomic: readNoiseFloor reads
        // without the lock, so it must never see a half-written file.
        fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
        fs.renameSync(tmp, file);
      } catch (err) {
        fs.rmSync(tmp, {force: true});
        writeError = `could not write ${file}: ${String(err)}`;
      }
    });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (!locked) return 'the noise ledger stayed locked by another live process';
  return writeError;
}
