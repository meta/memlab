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
import {execFileSync} from 'child_process';
import fs from 'fs';
import {test} from 'node:test';
import os from 'os';
import path from 'path';
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
const {RECORD_CONTRACT_VERSION, noteRecord} = await load('session-record.js');
const {registerRoundAudit} = await load('tools/round-audit.js');
const {registerLeakReport} = await load('tools/leak-report.js');
const {registerVerifyFix} = await load('tools/verify-fix.js');
const {registerFindingIndex} = await load('tools/finding-index.js');
const {registerLoadSnapshot} = await load('tools/load-snapshot.js');
const {registerDuplicatedStrings} = await load('tools/duplicated-strings.js');
const {registerLargestObjects} = await load('tools/largest-objects.js');
const {resetEmittedNotes} = await load('heap-state.js');
const {resetSuggestionBudget} = await load('utils.js');
const {z} = await import('zod');

/** Call a tool's handler with its zod defaults applied, as the SDK would. */
async function callTool(register, input) {
  let reg;
  register({tool: (...args) => (reg = args)});
  const shape = reg.find(
    a =>
      a != null &&
      typeof a === 'object' &&
      Object.values(a).some(v => v?._def != null),
  );
  const res = await reg.at(-1)(z.object(shape ?? {}).parse(input));
  return res.content.map(c => c.text).join('\n');
}

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
  const {data, kind, tool} = recs[0];
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

test('recordLabel hashes string contents and keeps class names', async () => {
  const {recordLabel} = await load('session-record.js');
  assert.equal(recordLabel('Map', 'object'), 'Map');
  const a = recordLabel('secret token value', 'string');
  assert.match(a, /^\(string [0-9a-f]{12}\)$/);
  assert.equal(recordLabel('secret token value', 'concatenated string'), a);
  assert.ok(!a.includes('secret'));
});

/** Three snapshots of a node process in which `LeakyThing` grows by `perRung` per rung. */
function growingLadder(perRung = 300) {
  const dir = tmp();
  const script = `
    const v8 = require('v8');
    class LeakyThing { constructor(i) { this.i = i; } }
    globalThis.kept = [];
    for (let i = 0; i < 300; i++) globalThis.kept.push(new LeakyThing(i));
    for (let rung = 0; rung < 3; rung++) {
      for (let i = 0; i < ${perRung}; i++) globalThis.kept.push(new LeakyThing(i));
      v8.writeHeapSnapshot(process.argv[1] + '/rung_' + rung + '.heapsnapshot');
    }`;
  execFileSync(process.execPath, ['-e', script, dir]);
  return [0, 1, 2].map(i => path.join(dir, `rung_${i}.heapsnapshot`));
}

async function leakReport(paths) {
  let handler;
  registerLeakReport({tool: (...args) => (handler = args.at(-1))});
  const res = await handler({
    paths,
    cycles: [0, 10, 20],
    limit: 10,
    min_growth_count: 50,
    monotonic_only: true,
    include_artifacts: false,
    auto_baseline: false,
    compact: false,
  });
  return res.content.map(c => c.text).join('\n');
}

test('leak_report records one row per class with its verdict, and its answer is unchanged', async () => {
  const paths = growingLadder();
  const file = path.join(tmp(), 'records.jsonl');
  const plain = await withRecordFile(null, () => leakReport(paths));
  const recorded = await withRecordFile(file, () => leakReport(paths));
  assert.equal(
    recorded.replace(/\d+(\.\d+)?\s?(ms|s)\b/g, ''),
    plain.replace(/\d+(\.\d+)?\s?(ms|s)\b/g, ''),
  );

  const recs = readRecords(file);
  assert.equal(recs.length, 1);
  const {data, kind, tool} = recs[0];
  assert.equal(tool, 'memlab_leak_report');
  assert.equal(kind, 'leak_report');
  assert.equal(data.rungs, 3);
  assert.equal(data.cycles, 20);
  assert.equal(data.min_growth_count, 50);
  const row = data.rows.find(r => r.class === 'LeakyThing');
  assert.ok(row, JSON.stringify(data.rows.map(r => r.class)));
  assert.equal(row.net_count, 600);
  assert.equal(row.per_cycle, 30);
  assert.equal(row.verdict, 'leak_candidate');
  assert.equal(row.settled, null);
  assert.ok(data.leak_candidates >= 1);
});

async function verifyFix(before, after) {
  let handler;
  registerVerifyFix({tool: (...args) => (handler = args.at(-1))});
  const res = await handler({
    metric_kind: 'class_count',
    locator: 'LeakyThing',
    before_paths: before,
    after_paths: after,
    cycles: 10,
    expected_reduction: 0.9,
    chain_edge: 'next',
    max_file_size_mb: 4096,
  });
  return res.content.map(c => c.text).join('\n');
}

test('verify_fix records its verdict and rates, and its answer is unchanged', async () => {
  const before = growingLadder(300);
  const after = growingLadder(0);
  const file = path.join(tmp(), 'records.jsonl');
  const plain = await withRecordFile(null, () => verifyFix(before, after));
  const recorded = await withRecordFile(file, () => verifyFix(before, after));
  assert.equal(recorded, plain);
  const recs = readRecords(file);
  assert.equal(recs.length, 1);
  const {data, kind, tool} = recs[0];
  assert.equal(tool, 'memlab_verify_fix');
  assert.equal(kind, 'verify_fix');
  assert.equal(data.verdict, 'FIX_CONFIRMED', plain);
  assert.match(plain, /FIX CONFIRMED/);
  assert.equal(data.metric_kind, 'class_count');
  assert.equal(data.locator, 'LeakyThing');
  assert.equal(data.before_rate, 30);
  assert.equal(data.after_rate, 0);
  assert.equal(data.reduction, 1);
  assert.equal(data.second_pair, false);
});

test('verify_fix records INCONCLUSIVE when the before arm does not grow', async () => {
  const flat = growingLadder(0);
  const file = path.join(tmp(), 'records.jsonl');
  await withRecordFile(file, () => verifyFix(flat, flat));
  const [rec] = readRecords(file);
  assert.equal(rec.data.verdict, 'INCONCLUSIVE');
  assert.equal(rec.data.reason, 'before_not_growing');
});

async function findingIndex(args) {
  let handler;
  registerFindingIndex({tool: (...a) => (handler = a.at(-1))});
  const res = await handler({growing_classes: [], ...args});
  return res.content.map(c => c.text).join('\n');
}

test('finding_index check records NEW and KNOWN verdicts with fingerprints; record and import write none', async () => {
  const before = process.env.MEMLAB_FINDINGS_INDEX;
  process.env.MEMLAB_FINDINGS_INDEX = path.join(tmp(), 'findings.json');
  try {
    const file = path.join(tmp(), 'records.jsonl');
    const pathA = 'Window -> cache (property) -> LeakyThing';
    await withRecordFile(file, () =>
      findingIndex({
        action: 'record',
        retainer_path: pathA,
        growing_classes: ['LeakyThing'],
        round: 'r1',
        status: 'known',
      }),
    );
    assert.equal(readRecords(file).length, 0);
    const known = await withRecordFile(file, () =>
      findingIndex({
        action: 'check',
        retainer_path: pathA,
        growing_classes: ['LeakyThing'],
      }),
    );
    const fresh = await withRecordFile(file, () =>
      findingIndex({
        action: 'check',
        retainer_path: 'Window -> other (property) -> Thing',
        growing_classes: ['Thing'],
      }),
    );
    const recs = readRecords(file);
    assert.equal(recs.length, 2);
    assert.ok(
      recs.every(
        r => r.tool === 'memlab_finding_index' && r.kind === 'finding_check',
      ),
    );
    const [k, n] = recs.map(r => r.data.matches[0]);
    assert.equal(k.verdict, 'KNOWN');
    assert.deepEqual(k.classes, ['LeakyThing']);
    assert.ok(known.includes(k.fingerprint));
    assert.equal(n.verdict, 'NEW');
    assert.ok(fresh.includes(n.fingerprint));
    assert.notEqual(k.fingerprint, n.fingerprint);
  } finally {
    if (before == null) {
      delete process.env.MEMLAB_FINDINGS_INDEX;
    } else {
      process.env.MEMLAB_FINDINGS_INDEX = before;
    }
  }
});

/** One node snapshot holding 400 copies of one long string and a big array. */
function stringsSnapshot() {
  const file = path.join(tmp(), 'strings.heapsnapshot');
  const script = `
    const v8 = require('v8');
    class BigHolder { constructor() { this.items = new Array(50000).fill(0).map((_, i) => ({i})); } }
    globalThis.holder = new BigHolder();
    globalThis.copies = [];
    for (let i = 0; i < 400; i++) globalThis.copies.push(['private-value-', 'x'.repeat(80), String(i % 1)].join(''));
    v8.writeHeapSnapshot(process.argv[1]);`;
  execFileSync(process.execPath, ['-e', script, file]);
  return file;
}

test('duplicated_strings and largest_objects record optimization items without string contents', async () => {
  const snap = stringsSnapshot();
  await callTool(registerLoadSnapshot, {file_path: snap, quiet: true});
  const file = path.join(tmp(), 'records.jsonl');
  // Notes and suggestions are rationed per session; reset so both calls see
  // the same session.
  resetEmittedNotes();
  resetSuggestionBudget();
  const plainDup = await withRecordFile(null, () =>
    callTool(registerDuplicatedStrings, {limit: 5}),
  );
  resetEmittedNotes();
  resetSuggestionBudget();
  const dup = await withRecordFile(file, () =>
    callTool(registerDuplicatedStrings, {limit: 5}),
  );
  const big = await withRecordFile(file, () =>
    callTool(registerLargestObjects, {limit: 5}),
  );
  // The second call is served from the first one's string scan and skips the
  // once-per-session snapshot header; neither has to do with recording.
  const uncached = t =>
    t
      .replace(', which was itself already cached', '')
      .replace(/^> Snapshot: .*\n\n/, '');
  assert.equal(uncached(dup), uncached(plainDup));
  const recs = readRecords(file);
  assert.equal(recs.length, 2);
  const [d, l] = recs;
  assert.equal(d.tool, 'memlab_duplicated_strings');
  assert.equal(d.kind, 'optimization');
  assert.equal(d.data.source, 'duplicated_strings');
  assert.ok(d.data.items.length > 0);
  assert.ok(
    d.data.items.some(i => i.count >= 400),
    JSON.stringify(d.data.items),
  );
  assert.ok(d.data.total_bytes > 0);
  assert.ok(!JSON.stringify(d.data).includes('private-value'));
  assert.match(dup, /private-value/);
  assert.equal(l.tool, 'memlab_largest_objects');
  assert.equal(l.data.source, 'largest_objects');
  assert.ok(l.data.items.length > 0 && l.data.items.length <= 5);
  assert.ok(
    l.data.items.every(i => typeof i.bytes === 'number' && i.bytes > 0),
  );
  assert.equal(l.data.total_bytes, null);
  assert.match(big, /retained size/);
});
