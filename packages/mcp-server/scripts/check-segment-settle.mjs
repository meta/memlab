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
 * Unit tests for per-segment settle rungs (run-manifest.ts
 * `settleRungForSegment`, tools/settle-check.ts `segmentSettlePlan`): an A/B
 * round's OFF arm is never scored against the ON arm's settle rung.
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
if (!fs.existsSync(path.join(dist, 'run-manifest.js'))) {
  console.error(
    'check-segment-settle: dist/run-manifest.js is missing; build first.',
  );
  process.exit(1);
}
const {loadRunManifest, ladderSegments, settleRungForSegment} = await import(
  pathToFileURL(path.join(dist, 'run-manifest.js')).href
);
const {registerSettleCheck, segmentSettlePlan} = await import(
  pathToFileURL(path.join(dist, 'tools', 'settle-check.js')).href
);

function abRun({offSettle}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'segsettle-'));
  const snap = n => path.join(dir, 'snapshots', n);
  const rungs = [0, 1, 2, 3].map(i => ({
    index: i,
    path: snap(`rung_0${i}_c${(i % 2) * 60}.heapsnapshot`),
    cycles: (i % 2) * 60,
  }));
  const run = {
    rungs,
    ladder_splits_after_rung: [1],
    settle_rung: {
      path: snap('rung_99_settle.heapsnapshot'),
      after_rung_index: 3,
    },
    ab: {
      off: {
        rungs: [0, 1],
        ...(offSettle
          ? {
              settle_rung: {
                path: snap('rung_98_settle_off.heapsnapshot'),
                after_rung_index: 1,
              },
            }
          : {}),
      },
      on: {rungs: [2, 3]},
    },
  };
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run));
  return dir;
}

test('each arm is settled against a rung from its own isolate', () => {
  const dir = abRun({offSettle: true});
  const m = loadRunManifest(dir);
  const segs = ladderSegments(m);
  assert.equal(segs.length, 2);
  assert.match(settleRungForSegment(m, segs[0], 2).path, /rung_98_settle_off/);
  assert.match(settleRungForSegment(m, segs[1], 2).path, /rung_99_settle/);
  const plan = segmentSettlePlan(dir);
  assert.deepEqual(
    plan.map(p => [p.index, p.arm, p.cycles, path.basename(p.settledPath)]),
    [
      [0, 'off', 60, 'rung_98_settle_off.heapsnapshot'],
      [1, 'on', 60, 'rung_99_settle.heapsnapshot'],
    ],
  );
});

test('an arm with no settle rung of its own is not adjudicated', () => {
  const dir = abRun({offSettle: false});
  const m = loadRunManifest(dir);
  const segs = ladderSegments(m);
  const off = settleRungForSegment(m, segs[0], 2);
  assert.equal(off.path, null);
  assert.match(off.note, /NOT adjudicated/);
  assert.equal(segmentSettlePlan(dir)[0].settledPath, null);
});

test('an unsplit run keeps its one settle rung and no per-segment plan', () => {
  const dir = abRun({offSettle: false});
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
  run.ladder_splits_after_rung = [];
  delete run.ab;
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run));
  const m = loadRunManifest(dir);
  assert.match(
    settleRungForSegment(m, ladderSegments(m)[0], 1).path,
    /rung_99_settle/,
  );
  assert.equal(segmentSettlePlan(dir), null);
});

test('with no settle rung at all, the note does not point at another segment', () => {
  const dir = abRun({offSettle: false});
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
  delete run.settle_rung;
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run));
  const m = loadRunManifest(dir);
  for (const seg of ladderSegments(m)) {
    const {note, path: p} = settleRungForSegment(m, seg, 2);
    assert.equal(p, null);
    assert.match(note, /the round captured no settle rung/);
    assert.doesNotMatch(note, /segment 1's|no segment/);
  }
});

test('an earlier arm is told the settle rung is in a later segment', () => {
  const dir = abRun({offSettle: false});
  const m = loadRunManifest(dir);
  const {note} = settleRungForSegment(m, ladderSegments(m)[0], 2);
  assert.match(note, /in a later segment's isolate, after a reload/);
});

test('a segment whose rungs cannot be loaded does not fail the others', async () => {
  // As the server sets it: a bad snapshot throws instead of exiting.
  const {default: memlabCore} = await import('@memlab/core');
  memlabCore.config.errorHandling = memlabCore.ErrorHandling.Throw;
  const dir = abRun({offSettle: true});
  let handler;
  registerSettleCheck({
    tool: (_name, _description, _schema, cb) => {
      handler = cb;
    },
  });
  const result = await handler({
    run_dir: dir,
    limit: 25,
    min_growth: 100,
    trace_held: false,
    trace_sample: 40,
  });
  assert.notEqual(result.isError, true);
  const text = result.content.map(c => c.text ?? '').join('\n');
  assert.match(text, /### Segment 0 \(OFF arm\)[\s\S]*Not adjudicated/);
  assert.match(text, /### Segment 1 \(ON arm\)[\s\S]*Not adjudicated/);
});
