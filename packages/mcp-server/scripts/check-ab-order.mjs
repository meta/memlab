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
 * `abaNote`; run-manifest.ts `settleRungForSegment`).
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

function abaRun() {
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
      ladder_splits_after_rung: [1, 3],
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

test('the third arm says whether the effect reverses', () => {
  const fix = '**FIX EFFECTIVE** (−90%)';
  assert.match(abaNote(fix, 10, 1, 9), /\*\*reverses\*\*/);
  assert.match(abaNote(fix, 10, 1, 2), /does \*\*NOT\*\* reverse/);
  assert.equal(abaNote('NO EFFECT', 10, 9, 10), '');
  assert.equal(abaNote(fix, 10, 1, null), '');
});
