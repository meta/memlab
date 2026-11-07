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
 * Unit tests for slope-stats.ts: the least-squares slope with its 95% interval
 * and the FIX CONFIRMED / FIX FALLS SHORT / INCONCLUSIVE verdict that memlab_verify_fix prints.
 *
 *   npm run build-pkg && npm run test-units
 *
 * Runs against the BUILT dist/.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.join(here, '..', 'dist', 'slope-stats.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-slope-stats: dist/slope-stats.js is missing; build first.',
  );
  process.exit(1);
}
const {fitSlope, rateVerdict, t95} = await import(pathToFileURL(built).href);

const axis = (n, step) => Array.from({length: n}, (_, i) => i * step);

test('t95: exact small-df quantiles, the normal value past 30, none below 1', () => {
  assert.equal(t95(1), 12.706);
  assert.equal(t95(2), 4.303);
  assert.equal(t95(30), 2.042);
  assert.equal(t95(31), 1.96);
  assert.equal(t95(0), Infinity);
});

test('fitSlope: a perfect line has a zero-width interval', () => {
  const f = fitSlope(axis(4, 25), [100, 150, 200, 250]);
  assert.equal(f.slope, 2);
  assert.equal(f.r2, 1);
  assert.equal(f.df, 2);
  assert.equal(f.se, 0);
  assert.equal(f.lo, 2);
  assert.equal(f.hi, 2);
});

test('fitSlope: two points give a slope and no interval', () => {
  const f = fitSlope([0, 50], [10, 110]);
  assert.equal(f.slope, 2);
  assert.equal(f.se, null);
  assert.equal(f.lo, null);
  assert.equal(f.hi, null);
});

test('fitSlope: the interval matches a hand computation', () => {
  // x = 0,1,2,3; y = 0,1,3,3 -> slope 1.1, residual SS 0.7, df 2.
  const f = fitSlope([0, 1, 2, 3], [0, 1, 3, 3]);
  assert.ok(Math.abs(f.slope - 1.1) < 1e-12);
  const se = Math.sqrt(0.7 / 2 / 5);
  assert.ok(Math.abs(f.se - se) < 1e-12);
  assert.ok(Math.abs(f.hi - (1.1 + 4.303 * se)) < 1e-9);
});

test('rateVerdict: a fix that removes the growth is FIX_CONFIRMED', () => {
  const before = fitSlope(axis(4, 25), [100, 150, 200, 250]);
  const after = fitSlope(axis(4, 25), [100, 101, 100, 101]);
  const v = rateVerdict(before, after, 0.9);
  assert.equal(v.verdict, 'FIX_CONFIRMED');
  assert.equal(v.reason, null);
  assert.ok(Math.abs(v.threshold - 0.2) < 1e-12);
});

test('rateVerdict: a fix that removes half falls short of a 90% threshold', () => {
  const before = fitSlope(axis(4, 25), [100, 150, 200, 250]);
  const after = fitSlope(axis(4, 25), [100, 125, 150, 175]);
  assert.equal(rateVerdict(before, after, 0.9).verdict, 'FIX_FALLS_SHORT');
  assert.equal(rateVerdict(before, after, 0.5).verdict, 'FIX_CONFIRMED');
});

test('rateVerdict: a noisy after arm is INCONCLUSIVE with what it can confirm', () => {
  const before = fitSlope(axis(4, 25), [100, 150, 200, 250]);
  const after = fitSlope(axis(4, 25), [100, 140, 90, 120]);
  const v = rateVerdict(before, after, 0.9);
  assert.equal(v.verdict, 'INCONCLUSIVE');
  assert.equal(v.reason, 'interval_crosses_threshold');
  assert.ok(v.confirmableReduction >= 0 && v.confirmableReduction < 0.9);
});

test('rateVerdict: two rungs, or a before arm not shown growing, decide nothing', () => {
  const two = fitSlope([0, 25], [100, 150]);
  const flatAfter = fitSlope(axis(4, 25), [100, 100, 100, 100]);
  assert.equal(rateVerdict(two, flatAfter, 0.9).reason, 'too_few_rungs');
  const noisyBefore = fitSlope(axis(4, 25), [100, 160, 90, 140]);
  assert.equal(
    rateVerdict(noisyBefore, flatAfter, 0.9).reason,
    'before_not_growing',
  );
});

test('rateVerdict: a run-to-run spread widens the after interval, and a large one decides nothing', () => {
  const before = fitSlope(axis(4, 25), [100, 150, 200, 250]);
  const after = fitSlope(axis(4, 25), [100, 101, 100, 101]);
  // The threshold is 2 * 0.1 = 0.2/cycle and the removal under test 1.8/cycle.
  const small = rateVerdict(before, after, 0.9, 0.1);
  assert.equal(small.verdict, 'FIX_CONFIRMED');
  const mid = rateVerdict(before, after, 0.9, 1);
  assert.equal(mid.verdict, 'INCONCLUSIVE');
  assert.equal(mid.reason, 'interval_crosses_threshold');
  const big = rateVerdict(before, after, 0.9, 1.8);
  assert.equal(big.reason, 'run_to_run_noise');
});

test('rateVerdict: with no spread, expected_reduction 0 still reaches a verdict', () => {
  const before = fitSlope(axis(4, 25), [100, 150, 200, 250]);
  const after = fitSlope(axis(4, 25), [100, 101, 100, 101]);
  const v = rateVerdict(before, after, 0, 0);
  assert.equal(v.verdict, 'FIX_CONFIRMED');
  assert.equal(v.reason, null);
});
