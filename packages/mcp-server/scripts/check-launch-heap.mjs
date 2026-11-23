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
 * Unit tests for the launcher's heap sizing (launch-heap.ts).
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
const built = path.join(here, '..', 'dist', 'launch-heap.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-launch-heap: dist/launch-heap.js is missing; build first.',
  );
  process.exit(1);
}
const {
  cgroupLimitMB,
  defaultMaxOldSpaceMB,
  resolveMaxOldSpaceMB,
  heapLimitIsSet,
} = await import(pathToFileURL(built).href);

test('60% of RAM, floored at 8 GB and capped at 48 GB', () => {
  assert.equal(defaultMaxOldSpaceMB(8 * 1024, 0), 8192);
  assert.equal(defaultMaxOldSpaceMB(64 * 1024, 0), 38 * 1024);
  assert.equal(defaultMaxOldSpaceMB(256 * 1024, 0), 49152);
  assert.equal(defaultMaxOldSpaceMB(0, 0), 8192);
});

test('a container cap wins, with no 8 GB floor', () => {
  assert.equal(defaultMaxOldSpaceMB(256 * 1024, 4096), 2048);
  assert.equal(defaultMaxOldSpaceMB(256 * 1024, 32 * 1024), 19 * 1024);
});

test('cgroup files: "max" and the v1 sentinel are uncapped', () => {
  assert.equal(
    cgroupLimitMB(() => 'max'),
    0,
  );
  assert.equal(
    cgroupLimitMB(() => String(2 ** 63)),
    0,
  );
  assert.equal(
    cgroupLimitMB(() => String(4 * 1024 ** 3)),
    4096,
  );
});

test('MEMLAB_MAX_OLD_SPACE_MB overrides, and a bad value is refused', () => {
  assert.equal(resolveMaxOldSpaceMB('6000'), 6000);
  assert.throws(() => resolveMaxOldSpaceMB('100'), />= 512/);
  assert.throws(() => resolveMaxOldSpaceMB('lots'), />= 512/);
});

test('a heap flag on the command line or in NODE_OPTIONS is kept', () => {
  assert.equal(heapLimitIsSet(['--max-old-space-size=3000'], ''), true);
  assert.equal(heapLimitIsSet([], '--inspect --max_old_space_size=3000'), true);
  assert.equal(heapLimitIsSet(['--inspect'], undefined), false);
  assert.equal(heapLimitIsSet([], '--max-semi-space-size=64'), false);
});
