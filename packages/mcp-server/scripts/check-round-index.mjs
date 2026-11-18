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
 * Unit tests for round-index.ts: resolving a round name against the shared
 * round index, and refreshing an indexed round's analysis.
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
const built = path.join(here, '..', 'dist', 'round-index.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-round-index: dist/round-index.js is missing; build first.',
  );
  process.exit(1);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memlab-round-index-'));
process.env.MEMLAB_ROUND_INDEX = path.join(tmp, 'index');
const {
  resolveRoundDir,
  refreshIndexedRound,
  indexProvenance,
  publishedFrom,
  roundIndexRoot,
} = await import(pathToFileURL(built).href);

function write(file, text) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, text);
}

const runDir = path.join(tmp, 'host-a', 'r7');
write(path.join(runDir, 'run.json'), '{"run_id": "r7"}');
write(path.join(runDir, 'snapshots', 'rung_00.heapsnapshot'), 'x');
const entry = path.join(tmp, 'index', 'web', 'r7');
write(path.join(entry, 'run.json'), '{"run_id": "r7"}');
write(
  path.join(entry, 'summary.json'),
  JSON.stringify({round: 'r7', app: 'web', host: 'host-a', run_dir: runDir}),
);

test('a round name resolves to its index entry; a path wins', () => {
  assert.equal(resolveRoundDir('r7'), entry);
  assert.equal(resolveRoundDir('web/r7'), entry);
  assert.equal(resolveRoundDir(runDir), runDir);
  assert.throws(() => resolveRoundDir('r8'), /no round of that name/);
});

test('a name two apps share must be qualified', () => {
  const other = path.join(tmp, 'index', 'ads', 'r7');
  write(path.join(other, 'run.json'), '{}');
  assert.throws(
    () => resolveRoundDir('r7'),
    /ads\/r7, web\/r7|web\/r7, ads\/r7/,
  );
  fs.rmSync(other, {recursive: true});
});

test('provenance names the host and run directory', () => {
  assert.match(
    indexProvenance(entry),
    /web\/r7, run on host-a in .*host-a\/r7/,
  );
  assert.equal(indexProvenance(runDir), null);
  assert.deepEqual(publishedFrom(entry), {runDir, host: 'host-a'});
});

test('refresh copies analysis output, not snapshots', () => {
  write(path.join(runDir, 'analysis', 'memlab_leak_report.txt'), 'report');
  assert.equal(refreshIndexedRound(runDir), entry);
  assert.equal(
    fs.readFileSync(
      path.join(entry, 'analysis', 'memlab_leak_report.txt'),
      'utf8',
    ),
    'report',
  );
  assert.ok(!fs.existsSync(path.join(entry, 'snapshots')));
  assert.equal(refreshIndexedRound(path.join(tmp, 'host-a', 'r9')), null);
});

test('a staging entry is not a round', () => {
  write(path.join(tmp, 'index', 'web', '.r9.tmp123', 'run.json'), '{}');
  assert.throws(
    () => resolveRoundDir('.r9.tmp123'),
    /no round of that name|not/,
  );
  assert.throws(() => resolveRoundDir('r9'), /no round of that name/);
});

test('an empty MEMLAB_ROUND_INDEX means the default root', () => {
  const saved = process.env.MEMLAB_ROUND_INDEX;
  process.env.MEMLAB_ROUND_INDEX = '';
  try {
    assert.equal(
      roundIndexRoot(),
      path.join(os.homedir(), '.memlab-mcp', 'rounds'),
    );
  } finally {
    process.env.MEMLAB_ROUND_INDEX = saved;
  }
});
