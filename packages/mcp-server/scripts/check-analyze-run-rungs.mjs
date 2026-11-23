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
 * Unit tests for `dropRunRungs` (tools/analyze-run.ts): an earlier call's
 * `run_first`/`run_last` are unloaded before a new pair, and nothing else is.
 *
 *   npm run build-pkg && npm run test-units
 *
 * Runs against the BUILT dist/.
 */
import assert from 'assert/strict';
import fs from 'fs';
import {test} from 'node:test';
import path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
if (!fs.existsSync(path.join(dist, 'tools', 'analyze-run.js'))) {
  console.error(
    'check-analyze-run-rungs: dist/tools/analyze-run.js is missing; build first.',
  );
  process.exit(1);
}
const hs = await import(pathToFileURL(path.join(dist, 'heap-state.js')).href);
const {dropRunRungs} = await import(
  pathToFileURL(path.join(dist, 'tools', 'analyze-run.js')).href
);

const meta = name => ({
  fileName: name,
  nodeCount: 1,
  edgeCount: 0,
  totalSize: 0,
  env: 'browser',
});

test("an earlier call's rungs are dropped, the user's snapshots stay", () => {
  hs.clearAllSnapshots();
  hs.setSnapshot({}, '/x/mine.heapsnapshot', meta('mine'), {alias: 'mine'});
  for (const alias of ['run_first', 'run_last', 'run_first']) {
    hs.setSnapshot({}, `/x/${alias}.heapsnapshot`, meta(alias), {
      alias,
      replace: false,
    });
  }
  assert.deepEqual(
    dropRunRungs()
      .map(m => m.handle)
      .sort(),
    ['run_first', 'run_first#2', 'run_last'],
  );
  assert.deepEqual(
    hs.listSnapshots().map(m => m.handle),
    ['mine'],
  );
  assert.deepEqual(dropRunRungs(), []);
});
