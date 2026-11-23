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
 * Unit tests for `heaviestChildIndex` and `topDominatedChildren`
 * (dominator-index.ts).
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
const built = path.join(here, '..', 'dist', 'dominator-index.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-dominator-index: dist/dominator-index.js is missing; build first.',
  );
  process.exit(1);
}
const {heaviestChildIndex, topDominatedChildren} = await import(
  pathToFileURL(built).href
);

/**
 * `n` nodes; node i > 0 is dominated by `parentOf(i)` and retains `sizeOf(i)`.
 * Nodes are made on demand, so 2^24+ nodes fit in a few hundred MB.
 */
function heap(n, parentOf, sizeOf) {
  const make = i => ({
    id: 2 * i + 1,
    nodeIndex: i,
    retainedSize: sizeOf(i),
    get dominatorNode() {
      return make(i === 0 ? 0 : parentOf(i));
    },
  });
  return {
    nodes: {
      length: n,
      get: make,
      forEach(cb) {
        for (let i = 0; i < n; i++) cb(make(i));
      },
    },
  };
}

test('heaviest child and child count per parent', () => {
  // Node 0 dominates 1..6; node 1 dominates 7 and 8.
  const parent = [0, 0, 0, 0, 0, 0, 0, 1, 1];
  const size = [100, 50, 10, 60, 60, 5, 1, 30, 40];
  const snap = heap(
    9,
    i => parent[i],
    i => size[i],
  );
  const {heaviest, children} = heaviestChildIndex(snap);
  assert.equal(children[0], 6);
  assert.equal(children[1], 2);
  assert.equal(children[2], 0);
  // Ties keep the first child seen.
  assert.equal(heaviest[0], 3);
  assert.equal(heaviest[1], 8);
  assert.equal(heaviest[2], -1);
});

test('top children are sorted, capped and only for the asked parents', () => {
  const parent = [0, 0, 0, 0, 0, 0, 0, 1, 1];
  const size = [100, 50, 10, 60, 60, 5, 1, 30, 40];
  const snap = heap(
    9,
    i => parent[i],
    i => size[i],
  );
  const top = topDominatedChildren(snap, [1, 3], 3);
  assert.deepEqual(
    top.get(1).map(n => n.nodeIndex),
    [3, 4, 1],
  );
  assert.deepEqual(
    top.get(3).map(n => n.nodeIndex),
    [8, 7],
  );
  assert.equal(top.size, 2);
});

test('a heap over 2^24 nodes does not hit the Map size limit', () => {
  const n = 2 ** 24 + 4096;
  const snap = heap(
    n,
    i => (i - 1) >> 1,
    i => n - i,
  );
  const {heaviest, children} = heaviestChildIndex(snap);
  assert.equal(children[0], 2);
  assert.equal(children[1], 2);
  assert.equal(heaviest[1], 3);
  assert.equal(heaviest[n - 1], -1);
});
