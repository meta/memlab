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
const {coHoldersOf, heldOnlyWithTooling, reachabilityOf} = await import(
  pathToFileURL(built).href
);

function graph() {
  const nodes = new Map();
  const node = (id, name, retainedSize = 0, type = 'object', self_size = 0) => {
    const n = {
      id,
      name,
      type,
      retainedSize,
      self_size,
      references: [],
      referrers: [],
    };
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
    snapshot: {
      getNodeById: id => nodes.get(id) ?? null,
      nodes: {forEach: fn => nodes.forEach(n => fn(n))},
    },
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

test("the population's own subgraph is not another holder", () => {
  const g = graph();
  const entry = g.node(10, 'Entry');
  const config = g.node(20, 'Config', 1_000);
  const schema = g.node(21, 'ConfigSchema', 400_000);
  const box = g.node(22, 'Box', 2_000);
  const inner = g.node(23, 'Inner');
  inner.dominatorNode = box;
  box.dominatorNode = entry;
  const cache = g.node(30, 'Cache');
  g.edge(entry, config, 'config');
  g.edge(entry, schema, 'schema');
  g.edge(entry, box, 'box');
  g.edge(config, schema, 'schema');
  g.edge(box, inner, 'inner');
  g.edge(inner, schema, 'schema');
  g.edge(cache, schema, 'last');
  const {groups} = coHoldersOf(g.snapshot, [10]);
  assert.deepEqual(
    groups.map(x => x.label),
    ['Cache.last'],
  );
});

test('tooling share counts only what the population and tooling hold together', () => {
  const g = graph();
  const root = g.node(1, '(GC roots)', 0, 'synthetic');
  const app = g.node(5, 'App', 0, 'object', 10);
  const entry = g.node(10, 'Entry', 0, 'object', 100);
  const shared = g.node(20, 'Payload', 0, 'object', 1_000);
  const own = g.node(21, 'Owned', 0, 'object', 7);
  const consoleRoot = g.node(31, 'Console', 0, 'object', 50);
  const logged = g.node(40, 'Logged', 0, 'object', 5_000);
  g.edge(root, app, 'app');
  g.edge(root, consoleRoot, 'console');
  g.edge(app, entry, 'entry');
  g.edge(entry, shared, 'data');
  g.edge(entry, own, 'own');
  g.edge(consoleRoot, shared, '0');
  g.edge(consoleRoot, logged, '1');
  const reach = reachabilityOf(g.snapshot);
  assert.equal(heldOnlyWithTooling(g.snapshot, [10], [31], reach), 1_000);
});
