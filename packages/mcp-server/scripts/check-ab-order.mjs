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
 * Unit tests for OFF → ON → OFF rounds (tools/ab-compare.ts `readArms`,
 * `abaNote`; run-manifest.ts `settleRungForSegment`), and for the battery on
 * split rounds (tools/analysis-battery.ts `batterySegment`, `batteryRungs`,
 * `segmentPlan`).
 *
 *   npm run build-pkg && npm run test-units
 *
 * Runs against the BUILT dist/.
 */
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
if (!fs.existsSync(path.join(dist, 'tools', 'ab-compare.js'))) {
  console.error(
    'check-ab-order: dist/tools/ab-compare.js is missing; build first.',
  );
  process.exit(1);
}
const {readArms, abaNote} = await import(
  pathToFileURL(path.join(dist, 'tools', 'ab-compare.js')).href
);
const {loadRunManifest, ladderSegments, settleRungForSegment} = await import(
  pathToFileURL(path.join(dist, 'run-manifest.js')).href
);
const {abSegments, batteryRungs, batterySegment, segmentPlan} = await import(
  pathToFileURL(path.join(dist, 'tools', 'analysis-battery.js')).href
);

function abaRun(splits = [1, 3]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aba-'));
  const rung = (index, cycles) => ({
    index,
    path: path.join(dir, `rung_${index}.heapsnapshot`),
    cycles,
  });
  const rungs = [
    rung(0, 0),
    rung(1, 30),
    rung(2, 30),
    rung(3, 60),
    rung(4, 60),
    rung(5, 90),
  ];
  fs.writeFileSync(
    path.join(dir, 'run.json'),
    JSON.stringify({
      rungs,
      totals: {cycles: 90},
      ladder_splits_after_rung: splits,
      settle_rung: {path: path.join(dir, 'rung_99_settle.heapsnapshot')},
      ab: {
        off: {
          prop: 'p',
          value: false,
          rungs: [0, 1],
          settle_rung: {path: path.join(dir, 'off.heapsnapshot')},
        },
        on: {
          prop: 'p',
          value: true,
          rungs: [2, 3],
          settle_rung: {path: path.join(dir, 'on.heapsnapshot')},
        },
        off2: {prop: 'p', value: false, rungs: [4, 5]},
      },
    }),
  );
  return dir;
}

test('an ABA round has three arms in order', () => {
  const arms = readArms(abaRun());
  assert.deepEqual(
    arms.map(a => [a.name, a.paths.length]),
    [
      ['off', 2],
      ['on', 2],
      ['off2', 2],
    ],
  );
});

test('each arm is scored against its own settle rung', () => {
  const m = loadRunManifest(abaRun());
  const segs = ladderSegments(m);
  assert.equal(segs.length, 3);
  const names = segs.map(s =>
    path.basename(settleRungForSegment(m, s, segs.length).path ?? 'none'),
  );
  assert.deepEqual(names, [
    'off.heapsnapshot',
    'on.heapsnapshot',
    'rung_99_settle.heapsnapshot',
  ]);
});

test('a ladder never spans two arms, even where no reload was recorded', () => {
  for (const splits of [[], [3], [1, 3]]) {
    const dir = abaRun(splits);
    const m = loadRunManifest(dir);
    assert.deepEqual(m.splitAfterRung, [1, 3], `splits ${splits}`);
    assert.deepEqual(
      ladderSegments(m).map(s => [s.firstRung, s.lastRung]),
      [
        [0, 1],
        [2, 3],
        [4, 5],
      ],
    );
    const ab = abSegments(dir, m);
    assert.equal(ab?.off.segment, 0);
    assert.equal(ab?.on.segment, 1);
  }
});

test('the third arm says whether the effect reverses', () => {
  const fix = '**FIX EFFECTIVE** (−90%)';
  assert.match(abaNote(fix, 10, 1, 9), /\*\*reverses\*\*/);
  assert.match(abaNote(fix, 10, 1, 2), /does \*\*NOT\*\* reverse/);
  assert.equal(abaNote('NO EFFECT', 10, 9, 10), '');
  assert.match(abaNote(fix, 10, 1, null), /reversal is unchecked/);
  assert.equal(abaNote('NO EFFECT', 10, 9, null), '');
});

function reloadedRun(splits) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-'));
  const rungs = [0, 1, 2, 3, 4].map(index => ({
    index,
    path: path.join(dir, `rung_${index}.heapsnapshot`),
    cycles: index * 20,
  }));
  fs.writeFileSync(
    path.join(dir, 'run.json'),
    JSON.stringify({
      rungs,
      totals: {cycles: 80},
      ladder_splits_after_rung: splits,
    }),
  );
  return dir;
}

test('a split round runs its ladder steps on the longest segment', () => {
  assert.equal(batterySegment(loadRunManifest(reloadedRun([]))), null);
  const longest = batterySegment(loadRunManifest(reloadedRun([0])));
  assert.deepEqual([longest.firstRung, longest.lastRung], [1, 4]);
  // On a tie, the later segment.
  const tie = batterySegment(loadRunManifest(reloadedRun([0, 2, 3])));
  assert.deepEqual([tie.firstRung, tie.lastRung], [1, 2]);

  const dir = reloadedRun([0]);
  const plan = segmentPlan(
    [
      {tool: 'memlab_leak_report', args: {run_dir: dir}},
      {tool: 'memlab_ladder_probe', args: {run_dir: dir, probes: 'p'}},
      {tool: 'memlab_positive_controls', args: {run_dir: dir, segment: 0}},
      {
        tool: 'memlab_census_diff',
        args: {baseline: 'rung_0', target: 'rung_4'},
      },
      {tool: 'memlab_round_audit', args: {run_dir: dir}},
    ],
    longest,
  );
  assert.equal(plan[0].args.segment, 1);
  assert.equal(plan[1].args.segment, 1);
  assert.equal(plan[2].args.segment, 0, 'an explicit segment is kept');
  assert.deepEqual(
    [plan[3].args.baseline, plan[3].args.target].map(p => path.basename(p)),
    ['rung_1.heapsnapshot', 'rung_4.heapsnapshot'],
  );
  assert.equal(plan[4].args.segment, undefined);
});

test('a split round deep-dives the last rung of its chosen segment', () => {
  // Rungs 0-2 | 3 | 4: the first segment is the longest, not the last.
  const m = loadRunManifest(reloadedRun([2, 3]));
  const seg = batterySegment(m);
  assert.deepEqual([seg.firstRung, seg.lastRung], [0, 2]);
  const {baseRung, finalRung} = batteryRungs(m, seg);
  assert.deepEqual(
    [baseRung, finalRung].map(p => path.basename(p)),
    ['rung_0.heapsnapshot', 'rung_2.heapsnapshot'],
  );
  const whole = batteryRungs(m, null);
  assert.equal(path.basename(whole.finalRung), 'rung_4.heapsnapshot');
});
