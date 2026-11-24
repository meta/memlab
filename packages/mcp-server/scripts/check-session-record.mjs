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
 * Unit tests for session records (`MEMLAB_RECORD_FILE`).
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
if (!fs.existsSync(path.join(dist, 'session-record.js'))) {
  console.error(
    'check-session-record: dist/session-record.js is missing; build first.',
  );
  process.exit(1);
}
const load = rel => import(pathToFileURL(path.join(dist, rel)).href);
const {noteRecord, RECORD_CONTRACT_VERSION} = await load('session-record.js');
const {registerRoundAudit} = await load('tools/round-audit.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'session-record-'));

function readRecords(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

function withRecordFile(file, fn) {
  const before = process.env.MEMLAB_RECORD_FILE;
  if (file == null) {
    delete process.env.MEMLAB_RECORD_FILE;
  } else {
    process.env.MEMLAB_RECORD_FILE = file;
  }
  return Promise.resolve(fn()).finally(() => {
    if (before == null) {
      delete process.env.MEMLAB_RECORD_FILE;
    } else {
      process.env.MEMLAB_RECORD_FILE = before;
    }
  });
}

test('noteRecord writes nothing unless MEMLAB_RECORD_FILE is set', async () => {
  const dir = tmp();
  await withRecordFile(null, () => noteRecord('t', 'leak_report', {a: 1}));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('noteRecord appends one JSON line per call', async () => {
  const file = path.join(tmp(), 'records.jsonl');
  await withRecordFile(file, () => {
    noteRecord('memlab_a', 'leak_report', {n: 1});
    noteRecord('memlab_b', 'verify_fix', {n: 2});
  });
  const recs = readRecords(file);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].contract, RECORD_CONTRACT_VERSION);
  assert.equal(recs[0].tool, 'memlab_a');
  assert.equal(recs[1].kind, 'verify_fix');
  assert.deepEqual(recs[1].data, {n: 2});
  assert.ok(!Number.isNaN(Date.parse(recs[0].at)));
});

test('noteRecord never throws when the file cannot be written', async () => {
  const file = path.join(tmp(), 'missing-dir', 'records.jsonl');
  const errors = [];
  const orig = console.error;
  console.error = m => errors.push(String(m));
  try {
    await withRecordFile(file, () => noteRecord('memlab_a', 'leak_report', {}));
  } finally {
    console.error = orig;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /could not write the memlab_a record/);
});

function roundDir() {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, 'run.json'),
    JSON.stringify({
      run_id: 'r1',
      totals: {cycles: 60, ok: 58, fail: 2},
      rungs: [0, 20, 40, 60].map((c, index) => ({
        index,
        path: `snapshots/rung_${index}_c${c}.heapsnapshot`,
      })),
      settle_rung: {path: 'snapshots/rung_99_settle.heapsnapshot'},
      environment: {dev_build: false},
      config: {combos: ['open_chat']},
      positive_controls: [{name: 'p', kind: 'map-size', edge: 'm'}],
      stop_reason: 'cycles',
    }),
  );
  return dir;
}

async function audit(runDir) {
  let handler;
  registerRoundAudit({tool: (...args) => (handler = args.at(-1))});
  const res = await handler({run_dir: runDir});
  return res.content.map(c => c.text).join('\n');
}

test('round_audit records its verdict and the run shape, and its answer is unchanged', async () => {
  const dir = roundDir();
  const file = path.join(tmp(), 'records.jsonl');
  const plain = await withRecordFile(null, () => audit(dir));
  const recorded = await withRecordFile(file, () => audit(dir));
  assert.equal(recorded, plain);

  const recs = readRecords(file);
  assert.equal(recs.length, 1);
  const {tool, kind, data} = recs[0];
  assert.equal(tool, 'memlab_round_audit');
  assert.equal(kind, 'round_audit');
  assert.equal(data.run_id, 'r1');
  assert.match(plain, new RegExp(`Verdict: ${data.verdict}`));
  assert.equal(data.cycles, 60);
  assert.equal(data.cycles_landed, 58);
  assert.equal(data.rungs, 4);
  assert.equal(data.settle, true);
  assert.equal(data.dev_build, false);
  assert.deepEqual(data.combos, ['open_chat']);
  assert.equal(data.positive_controls, 1);
  assert.ok(data.checks.length > 0);
  for (const c of data.checks) {
    assert.deepEqual(Object.keys(c).sort(), ['name', 'status']);
  }
});
