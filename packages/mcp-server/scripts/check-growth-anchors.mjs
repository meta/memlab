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
 * Unit tests for `growthAnchors` (tools/growth-anchors.ts): each new object
 * lands under the nearest pre-existing dominator, the root when there is none,
 * and no byte is counted twice.
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
const built = path.join(here, '..', 'dist', 'tools', 'growth-anchors.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-growth-anchors: dist/tools/growth-anchors.js is missing; build first.',
  );
  process.exit(1);
}
const {growthAnchors} = await import(pathToFileURL(built).href);

/**
 * A fake dominator tree: `nodes` is [idom, isNew, self, retained] per index.
 * Index 0 is the root (its own dominator).
 */
function run(nodes, counted) {
  return growthAnchors({
    isNew: Uint8Array.from(nodes.map(n => n[1])),
    counted: counted == null ? undefined : Uint8Array.from(counted),
    idom: Int32Array.from(nodes.map(n => n[0])),
    self: nodes.map(n => n[2]),
    retained: nodes.map(n => n[3]),
    root: 0,
  });
}

// 0 root, 1 old Map, 2 new entry (under 1), 3 new value (under 2),
// 4 old object moved under new 2, 5 new under root via new 6, 6 new under root.
const tree = [
  [0, 0, 0, 100],
  [0, 0, 10, 60],
  [1, 1, 20, 50],
  [2, 1, 5, 5],
  [2, 0, 25, 25],
  [6, 1, 3, 3],
  [0, 1, 7, 10],
];

test('new objects land under the nearest pre-existing dominator', () => {
  const {anchor, top} = run(tree);
  assert.equal(anchor[2], 1);
  assert.equal(anchor[3], 1);
  assert.equal(top[3], 2);
  assert.equal(anchor[1], -1, 'old objects have no anchor');
  assert.equal(anchor[4], -1);
});

test('a chain of new objects up to the root anchors at the root', () => {
  const {anchor, top, totals} = run(tree);
  assert.equal(anchor[5], 0);
  assert.equal(anchor[6], 0);
  assert.equal(top[5], 6);
  assert.deepEqual(totals.get(0), {nodes: 2, self: 10, retained: 10});
});

test('self bytes are a partition and retained counts top-level objects once', () => {
  const {totals} = run(tree);
  // Map: new 2 and 3 (self 20 + 5); retained only of top-level 2 (50, which
  // includes the old object 4 that moved under it), never 50 + 5.
  assert.deepEqual(totals.get(1), {nodes: 2, self: 25, retained: 50});
  let self = 0;
  for (const t of totals.values()) self += t.self;
  assert.equal(self, 20 + 5 + 3 + 7);
});

test('uncounted new objects still resolve chains but add nothing', () => {
  const {anchor, totals} = run(tree, [0, 0, 0, 1, 0, 1, 1]);
  assert.equal(anchor[3], 1, 'chain passes through uncounted new 2');
  assert.deepEqual(totals.get(1), {nodes: 1, self: 5, retained: 0});
});

test('a deep chain visited bottom-up, and an unreachable node', () => {
  // 0..1999: new chain, i dominated by i+1, 1999 by the old 2001.
  // 2000: new and unreachable (no dominator). 2001: old. 2002: root.
  const n = 2003;
  const idom = new Int32Array(n);
  const isNew = new Uint8Array(n);
  for (let i = 0; i < 2000; i++) {
    idom[i] = i === 1999 ? 2001 : i + 1;
    isNew[i] = 1;
  }
  idom[2000] = -1;
  isNew[2000] = 1;
  idom[2001] = 2002;
  idom[2002] = 2002;
  const ones = new Array(n).fill(1);
  const {anchor, top, totals} = growthAnchors({
    isNew,
    idom,
    self: ones,
    retained: ones,
    root: 2002,
  });
  assert.equal(anchor[0], 2001);
  assert.equal(top[0], 1999);
  assert.deepEqual(totals.get(2001), {nodes: 2000, self: 2000, retained: 1});
  assert.equal(anchor[2000], 2002, 'unreachable new node anchors at the root');
});
