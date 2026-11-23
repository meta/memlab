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
 * Unit tests for auto-job promotion (auto-job.ts): a ladder call whose rungs
 * left to parse predict more than the foreground budget becomes a job.
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
if (!fs.existsSync(path.join(dist, 'auto-job.js'))) {
  console.error('check-auto-job: dist/auto-job.js is missing; build first.');
  process.exit(1);
}
const {shouldAutoJob, rungFilesOf, autoJobReply} = await import(
  pathToFileURL(path.join(dist, 'auto-job.js')).href
);
const hs = await import(pathToFileURL(path.join(dist, 'heap-state.js')).href);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-job-'));
const rung = name => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(2 * 1024 * 1024));
  return p;
};
const a = rung('rung_00.heapsnapshot');
const b = rung('rung_01.heapsnapshot');
process.env.MEMLAB_AUTO_JOB_MS = '150';

test('over the budget, a ladder call becomes a job', () => {
  const est = shouldAutoJob('memlab_ladder_probe', {paths: [a, b]});
  assert.equal(est.toParse, 2);
  assert.ok(est.ms > 150, `estimate ${est.ms}`);
  assert.match(
    autoJobReply('memlab_ladder_probe', 'ab12', est, false),
    /2 rung\(s\) to parse, predicted ~1 s, over the 0 s foreground budget/,
  );
});

test('under the budget, or opted out, it runs in the foreground', () => {
  assert.equal(shouldAutoJob('memlab_ladder_probe', {paths: [a]}), null);
  assert.equal(
    shouldAutoJob('memlab_ladder_probe', {paths: [a, b], background: false}),
    null,
  );
  assert.equal(shouldAutoJob('memlab_class_histogram', {paths: [a, b]}), null);
  // eval_across starts its own job with `async: true`.
  assert.equal(
    shouldAutoJob('memlab_eval_across', {paths: [a, b], async: true}),
    null,
  );
});

test('`background: true` always starts a job', () => {
  assert.notEqual(
    shouldAutoJob('memlab_ladder_probe', {paths: [a], background: true}),
    null,
  );
});

test('a resident rung costs nothing', () => {
  hs.clearAllSnapshots();
  hs.setSnapshot({}, a, {
    fileName: 'rung_00.heapsnapshot',
    nodeCount: 1,
    edgeCount: 0,
    totalSize: 0,
    env: 'browser',
  });
  const est = shouldAutoJob('memlab_ladder_probe', {
    paths: [a, b],
    background: true,
  });
  assert.equal(est.cached, 1);
  assert.equal(est.toParse, 1);
  hs.clearAllSnapshots();
});

test('rung files come from paths, run_dir or a snapshot path', () => {
  const run = path.join(dir, 'run');
  fs.mkdirSync(run);
  fs.writeFileSync(
    path.join(run, 'run.json'),
    JSON.stringify({
      rungs: [
        {index: 0, path: a, cycles: 0},
        {index: 1, path: b, cycles: 10},
      ],
      totals: {cycles: 10},
    }),
  );
  assert.deepEqual(rungFilesOf({run_dir: run}), [a, b]);
  assert.deepEqual(rungFilesOf({snapshot: a}), [a]);
  assert.deepEqual(rungFilesOf({snapshot: 'handle-name'}), []);
});

test('a .gz rung is priced at its inflated size', () => {
  const gz = path.join(dir, 'rung_02.heapsnapshot.gz');
  fs.writeFileSync(gz, Buffer.alloc(512 * 1024));
  const plain = rung('rung_03.heapsnapshot');
  const g = shouldAutoJob('memlab_ladder_probe', {
    snapshot: gz,
    background: true,
  });
  const p = shouldAutoJob('memlab_ladder_probe', {
    snapshot: plain,
    background: true,
  });
  assert.equal(g.ms, p.ms);
});
