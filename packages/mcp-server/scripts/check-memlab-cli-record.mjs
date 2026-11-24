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
 * `memlab-cli --record <file>` end to end: a real server child, a real script.
 *
 *   npm run build-pkg && npm run test-units
 *
 * Runs against the BUILT dist/.
 */
import assert from 'assert/strict';
import {spawnSync} from 'child_process';
import fs from 'fs';
import {test} from 'node:test';
import os from 'os';
import path from 'path';
import {fileURLToPath} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'bin', 'memlab-cli.js');
const server = path.join(here, '..', 'dist', 'index.js');
if (!fs.existsSync(server)) {
  console.error(
    'check-memlab-cli-record: dist/index.js is missing; build first.',
  );
  process.exit(1);
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cli-record-'));

function runCli(args) {
  const env = {...process.env, MEMLAB_MCP_SERVER: server};
  delete env.MEMLAB_RECORD_FILE;
  return spawnSync(process.execPath, [cli, ...args], {env, encoding: 'utf8'});
}

function roundScript() {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, 'run.json'),
    JSON.stringify({
      run_id: 'r1',
      totals: {cycles: 30, ok: 30},
      rungs: [0, 1, 2, 3].map(index => ({
        index,
        path: `rung_${index}.heapsnapshot`,
      })),
    }),
  );
  const steps = path.join(dir, 'steps.jsonl');
  fs.writeFileSync(
    steps,
    [
      JSON.stringify({tool: 'memlab_round_audit', args: {run_dir: dir}}),
      JSON.stringify({tool: 'memlab_server_status', args: {}}),
    ].join('\n'),
  );
  return steps;
}

test('script --record writes the records and leaves output and exit status alone', () => {
  const steps = roundScript();
  const file = path.join(tmp(), 'records.jsonl');
  fs.writeFileSync(file, 'stale line from an earlier session\n');
  const plain = runCli(['script', '--json', steps]);
  const recorded = runCli(['script', '--json', '--record', file, steps]);
  assert.equal(recorded.status, plain.status, recorded.stderr);
  const strip = out =>
    JSON.parse(out).map(r => ({
      ...r,
      text: r.text.replace(/\d[\d.,]*\s?(ms|s|MB|KB|GB|%)/g, ''),
    }));
  assert.deepEqual(strip(recorded.stdout), strip(plain.stdout));
  const recs = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
  // memlab-cli makes calls of its own around the steps; they are recorded too.
  assert.deepEqual(
    recs.slice(-3).map(r => [r.kind, r.tool]),
    [
      ['round_audit', 'memlab_round_audit'],
      ['tool_call', 'memlab_round_audit'],
      ['tool_call', 'memlab_server_status'],
    ],
  );
  assert.ok(recs.slice(0, -3).every(r => r.kind === 'tool_call'));
  const [rec, auditCall] = recs.slice(-3);
  assert.equal(rec.data.run_id, 'r1');
  assert.match(rec.round.key, /^[0-9a-f]{16}$/);
  assert.deepEqual(auditCall.round, rec.round);
  assert.equal((fs.statSync(file).mode % 0o1000).toString(8), '600');
});

test('without --record no file is written', () => {
  const steps = roundScript();
  const dir = path.dirname(steps);
  const before = fs.readdirSync(dir).sort();
  const res = runCli(['script', '--json', steps]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
});

test('--record is refused where it cannot work', () => {
  const steps = roundScript();
  const file = path.join(tmp(), 'r.jsonl');
  const socket = runCli([
    'script',
    '--socket',
    path.join(tmp(), 's.sock'),
    '--record',
    file,
    steps,
  ]);
  assert.equal(socket.status, 1);
  assert.match(socket.stderr, /--record does not work with --socket/);
  const list = runCli(['list', '--record', file]);
  assert.equal(list.status, 1);
  assert.match(list.stderr, /--record works with call and script, not list/);
  for (const cmd of ['serve', 'doctor']) {
    const res = runCli([cmd, '--record', file]);
    assert.equal(res.status, 1);
    assert.match(
      res.stderr,
      new RegExp(`--record works with call and script, not ${cmd}`),
    );
    assert.ok(!fs.existsSync(file));
  }
  const missing = runCli(['script', '--record']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--record needs a file/);
  const late = runCli(['script', steps, '--record', file]);
  assert.equal(late.status, 1);
  assert.match(late.stderr, /--record must come right after the command/);
});
