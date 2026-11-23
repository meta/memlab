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
 * Unit tests for native memory pinned by JavaScript (native-pins.ts): each
 * native node is charged to its nearest JS dominator.
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
const dist = path.join(here, '..', 'dist');
if (!fs.existsSync(path.join(dist, 'native-pins.js'))) {
  console.error(
    'check-native-pins: dist/native-pins.js is missing; build first.',
  );
  process.exit(1);
}
const {nativePins} = await import(
  pathToFileURL(path.join(dist, 'native-pins.js')).href
);

/** `[id, name, type, self, dominatorId]` rows. */
function tree(rows) {
  const nodes = rows.map(([id, name, type, self_size], nodeIndex) => ({
    id,
    name,
    type,
    self_size,
    nodeIndex,
    dominatorNode: null,
    references: [],
  }));
  const byId = new Map(nodes.map(n => [n.id, n]));
  rows.forEach(([, , , , dom], i) => {
    nodes[i].dominatorNode = byId.get(dom) ?? nodes[i];
  });
  return {
    nodes: {
      length: nodes.length,
      forEach: cb => nodes.forEach(cb),
      get: i => nodes[i],
    },
  };
}

test('natives are charged to the nearest JS dominator, grouped by pinner', () => {
  const snap = tree([
    [1, '', 'synthetic', 0, 1],
    [10, 'FontLoader', 'object', 40, 1],
    [11, 'system / PromiseReaction', 'hidden', 32, 10],
    [12, 'system / CppHeapExternal', 'hidden', 16, 11],
    [13, 'blink::TaskAttributionInfoImpl', 'native', 100, 12],
    [14, 'blink::SoftNavigationContext', 'native', 300, 13],
    [20, 'FontLoader', 'object', 40, 1],
    [21, 'blink::TaskAttributionInfoImpl', 'native', 100, 20],
    [30, 'blink::LayoutObject', 'native', 50, 1],
    [31, 'system / ExternalStringData', 'native', 9999, 10],
  ]);
  const r = nativePins(snap);
  assert.equal(r.total, 500);
  assert.equal(r.unpinned, 50);
  assert.equal(r.groups.length, 1);
  const [g] = r.groups;
  assert.equal(g.label, 'FontLoader');
  assert.equal(g.pinners, 2);
  assert.equal(g.natives, 3);
  assert.equal(g.bytes, 500);
  assert.deepEqual(g.classes[0], ['blink::SoftNavigationContext', 300]);
  assert.equal(g.sample, 10);
});
