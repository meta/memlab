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
 * Unit tests for `shapeGrowth` (tools/diff-snapshots.ts).
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
const built = path.join(here, '..', 'dist', 'tools', 'diff-snapshots.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-shape-growth: dist/tools/diff-snapshots.js is missing; build first.',
  );
  process.exit(1);
}
const {shapeGrowth} = await import(pathToFileURL(built).href);

function heap(groups) {
  const list = [];
  const leaf = {id: 5, name: 'x', type: 'string', references: []};
  for (const [cls, props, n] of groups) {
    for (let i = 0; i < n; i++) {
      list.push({
        id: 10 + list.length,
        name: cls,
        type: 'object',
        self_size: 32,
        references: props.map(p => ({
          type: 'property',
          name_or_index: p,
          toNode: leaf,
        })),
      });
    }
  }
  return {nodes: {forEach: cb => list.forEach(cb), length: list.length}};
}

test('ranks shapes by count growth, matching on constructor and property set', () => {
  const before = heap([
    ['t', ['listener', 'subscriber', 'remove'], 100],
    ['Object', ['a', 'b'], 500],
  ]);
  const after = heap([
    ['t', ['remove', 'subscriber', 'listener'], 700],
    ['Object', ['a', 'b'], 520],
    ['Object', ['frameId'], 60],
    ['Object', ['rare'], 10],
    ['Object', ['a'], 400],
  ]);
  const rows = shapeGrowth(before, after);
  assert.deepEqual(
    rows.map(r => [r.cls, r.props.join(','), r.before, r.after]),
    [
      ['t', 'listener,remove,subscriber', 100, 700],
      ['Object', 'a', 0, 400],
      ['Object', 'frameId', 0, 60],
      ['Object', 'a,b', 500, 520],
    ],
  );
  assert.equal(rows[0].selfDelta, 600 * 32);
});
