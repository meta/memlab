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
 * Unit tests for `attributeByModule` (tools/module-attribution.ts).
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
const built = path.join(here, '..', 'dist', 'tools', 'module-attribution.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-module-attribution: dist/tools/module-attribution.js is missing; build first.',
  );
  process.exit(1);
}
const {attributeByModule} = await import(pathToFileURL(built).href);

/**
 * A synthetic snapshot of `n` nodes whose dominator tree is a binary heap
 * (node i is dominated by node (i - 1) >> 1). Node objects are made on demand,
 * so a heap larger than V8's 2^24-entry Map limit fits in a few hundred MB.
 */
function binaryHeap(n) {
  const make = i => ({
    id: 2 * i + 1,
    nodeIndex: i,
    self_size: 8,
    get dominatorNode() {
      return make(i === 0 ? 0 : (i - 1) >> 1);
    },
  });
  return {
    nodes: {
      length: n,
      forEach(cb) {
        for (let i = 0; i < n; i++) cb(make(i));
      },
    },
  };
}

test('attributes every node under a module export to that module', () => {
  const snap = binaryHeap(1000);
  // Node index 1 (id 3 is a root id, so use index 2, id 5) is the export.
  const registries = [{moduleByNodeId: new Map([[5, 'ModA']])}];
  const {stats, attributed, unattributed} = attributeByModule(snap, registries);
  assert.equal(stats.length, 1);
  assert.equal(stats[0].module, 'ModA');
  // Index 2's subtree in a 1000-node binary heap, minus nothing: count it.
  let sub = 0;
  const stack = [2];
  while (stack.length > 0) {
    const i = stack.pop();
    if (i >= 1000) continue;
    sub++;
    stack.push(2 * i + 1, 2 * i + 2);
  }
  assert.equal(stats[0].nodes, sub);
  assert.equal(attributed, sub * 8);
  // Ids 1 and 3 (indexes 0 and 1) are skipped as roots.
  assert.equal(unattributed, (1000 - sub - 2) * 8);
});

test('a heap over 2^24 nodes does not hit the Map size limit', () => {
  const n = 2 ** 24 + 4096;
  const snap = binaryHeap(n);
  const registries = [{moduleByNodeId: new Map([[5, 'ModA']])}];
  const {stats} = attributeByModule(snap, registries);
  assert.equal(stats[0].module, 'ModA');
  assert.ok(stats[0].nodes > 2 ** 22);
});
