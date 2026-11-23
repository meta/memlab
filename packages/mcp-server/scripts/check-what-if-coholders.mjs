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
 * Unit tests for `coHoldersOf` (tools/what-if.ts).
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
const built = path.join(here, '..', 'dist', 'tools', 'what-if.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-what-if-coholders: dist/tools/what-if.js is missing; build first.',
  );
  process.exit(1);
}
const {coHoldersOf} = await import(pathToFileURL(built).href);

function graph() {
  const nodes = new Map();
  const node = (id, name, retainedSize = 0, type = 'object') => {
    const n = {id, name, type, retainedSize, references: [], referrers: []};
    nodes.set(id, n);
    return n;
  };
  const edge = (from, to, name, type = 'property') => {
    const e = {type, name_or_index: name, fromNode: from, toNode: to};
    from.references.push(e);
    to.referrers.push(e);
  };
  return {
    nodes,
    node,
    edge,
    snapshot: {getNodeById: id => nodes.get(id) ?? null},
  };
}

test('groups outside referrers of the children by class.edge', () => {
  const g = graph();
  const a = g.node(10, 'Entry');
  const b = g.node(11, 'Entry');
  const big1 = g.node(20, 'Payload', 500_000);
  const big2 = g.node(21, 'Payload', 300_000);
  const cache = g.node(30, 'Cache');
  const devtools = g.node(31, 'Console');
  g.edge(a, big1, 'data');
  g.edge(b, big2, 'data');
  g.edge(cache, big1, '0');
  g.edge(cache, big2, '1');
  g.edge(devtools, big1, 'last');
  g.edge(a, b, 'next');
  const {payload, groups} = coHoldersOf(g.snapshot, [10, 11]);
  assert.equal(payload, 800_000);
  assert.equal(groups[0].label, 'Cache[i]');
  assert.equal(groups[0].children, 2);
  assert.equal(groups[0].bytes, 800_000);
  assert.deepEqual([...groups[0].holders], [30]);
  assert.equal(groups[1].label, 'Console.last');
  assert.equal(groups[1].bytes, 500_000);
});

test('ignores weak edges, structural edges and members of the population', () => {
  const g = graph();
  const a = g.node(10, 'Entry');
  const proto = g.node(40, 'Object', 900_000);
  const child = g.node(41, 'Payload', 100_000);
  const weakHolder = g.node(50, 'WeakRef');
  g.edge(a, proto, '__proto__');
  g.edge(a, child, 'data');
  g.edge(weakHolder, child, 'target', 'weak');
  const {payload, groups} = coHoldersOf(g.snapshot, [10]);
  assert.equal(payload, 100_000);
  assert.equal(groups.length, 0);
});
