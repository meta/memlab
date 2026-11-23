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
 * Unit tests for `NodeIndexSet` (node-index-set.ts).
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
const built = path.join(here, '..', 'dist', 'node-index-set.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-node-index-set: dist/node-index-set.js is missing; build first.',
  );
  process.exit(1);
}
const {NodeIndexSet} = await import(pathToFileURL(built).href);

test('add reports new members, has and size follow', () => {
  const s = new NodeIndexSet(10);
  assert.equal(s.add({nodeIndex: 3}), true);
  assert.equal(s.add({nodeIndex: 3}), false);
  assert.equal(s.addIndex(7), true);
  assert.equal(s.has({nodeIndex: 3}), true);
  assert.equal(s.hasIndex(4), false);
  assert.equal(s.size, 2);
  assert.deepEqual([...s.indexes()], [3, 7]);
});

test('holds more than 2^24 members, where a Set throws', () => {
  const n = 2 ** 24 + 16;
  const s = new NodeIndexSet(n);
  for (let i = 0; i < n; i++) s.addIndex(i);
  assert.equal(s.size, n);
  assert.equal(s.hasIndex(n - 1), true);
  assert.throws(() => {
    const big = new Set();
    for (let i = 0; i < n; i++) big.add(i);
  }, /maximum size/);
});
