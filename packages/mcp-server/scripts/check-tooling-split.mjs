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
 * Unit tests for `toolingSplit` (tools/dev-artifacts.ts).
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
const built = path.join(here, '..', 'dist', 'tools', 'dev-artifacts.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-tooling-split: dist/tools/dev-artifacts.js is missing; build first.',
  );
  process.exit(1);
}
const {
  collectDevRoots,
  computeReachableWithoutDevRoots,
  toolingSplit,
  toolingVerdict,
} = await import(pathToFileURL(built).href);

function graph() {
  const list = [];
  const byId = new Map();
  const node = (id, name, self_size, type = 'object') => {
    const n = {
      id,
      name,
      type,
      self_size,
      retainedSize: self_size,
      nodeIndex: list.length,
      references: [],
      referrers: [],
      dominatorNode: null,
      hasPathEdge: false,
      forEachReference(cb) {
        for (const e of this.references) cb(e);
      },
    };
    list.push(n);
    byId.set(id, n);
    return n;
  };
  const edge = (from, to, name, type = 'property') => {
    const e = {type, name_or_index: name, fromNode: from, toNode: to};
    from.references.push(e);
    to.referrers.push(e);
  };
  const nodes = {
    length: 0,
    forEach(cb) {
      list.forEach(cb);
    },
    get: i => list[i] ?? null,
  };
  const snapshot = {nodes, getNodeById: id => byId.get(id) ?? null};
  return {node, edge, snapshot, finish: () => (nodes.length = list.length)};
}

// (GC roots) → Window → {__REACT_DEVTOOLS_GLOBAL_HOOK__ → hook → held,
//                        app → store → payload}
function heap() {
  const g = graph();
  const root = g.node(1, '(GC roots)', 0, 'synthetic');
  const win = g.node(5, 'Window / https://example.test', 100);
  const hook = g.node(7, 'Object', 50);
  const held = g.node(11, 'Object', 1000);
  const store = g.node(9, 'Store', 200);
  const payload = g.node(17, 'Array', 3000, 'array');
  g.edge(root, win, '1', 'element');
  g.edge(win, hook, '__REACT_DEVTOOLS_GLOBAL_HOOK__');
  g.edge(hook, held, 'renderers');
  g.edge(win, store, 'app');
  g.edge(store, payload, 'items');
  root.dominatorNode = root;
  win.dominatorNode = root;
  hook.dominatorNode = win;
  held.dominatorNode = hook;
  store.dominatorNode = win;
  payload.dominatorNode = store;
  store.retainedSize = 3200;
  g.finish();
  return g.snapshot;
}

test('splits tooling-only from app-held bytes, with a production path', () => {
  const snapshot = heap();
  const devRoots = collectDevRoots(snapshot);
  assert.ok(devRoots.byId.has(7), 'the DevTools hook is a dev root');
  const reached = computeReachableWithoutDevRoots(snapshot, devRoots);
  const [held, store] = toolingSplit(snapshot, devRoots, reached, [11, 9, 404]);
  assert.equal(held.appReachable, false);
  assert.equal(held.toolingOnly, 1000);
  assert.equal(held.appHeld, 0);
  assert.equal(held.path, null);
  assert.equal(store.appReachable, true);
  assert.equal(store.toolingOnly, 0);
  assert.equal(store.appHeld, 3200);
  assert.match(store.path, /Window \/ https:\/\/example\.test\.app → @9$/);
});

test('nested targets each include their complete dominated subtree', () => {
  const snapshot = heap();
  const devRoots = collectDevRoots(snapshot);
  const reached = computeReachableWithoutDevRoots(snapshot, devRoots);
  for (const ids of [
    [5, 17, 9],
    [17, 9, 5],
  ]) {
    const rows = new Map(
      toolingSplit(snapshot, devRoots, reached, ids).map(row => [
        row.node.id,
        row,
      ]),
    );
    assert.deepEqual(
      [rows.get(5).appHeld, rows.get(5).toolingOnly],
      [3300, 1050],
    );
    assert.deepEqual([rows.get(9).appHeld, rows.get(9).toolingOnly], [3200, 0]);
    assert.deepEqual(
      [rows.get(17).appHeld, rows.get(17).toolingOnly],
      [3000, 0],
    );
    const [hook, held] = toolingSplit(snapshot, devRoots, reached, [7, 11]);
    assert.deepEqual([hook.appHeld, hook.toolingOnly], [0, 1050]);
    assert.deepEqual([held.appHeld, held.toolingOnly], [0, 1000]);
  }
});

test('duplicate IDs produce one correctly sized row per existing target', () => {
  const snapshot = heap();
  const devRoots = collectDevRoots(snapshot);
  const reached = computeReachableWithoutDevRoots(snapshot, devRoots);
  const rows = toolingSplit(
    snapshot,
    devRoots,
    reached,
    [9, 9, 404, 11, 9, 11],
  );
  assert.deepEqual(
    rows.map(row => row.node.id),
    [9, 11],
  );
  assert.deepEqual(
    rows.map(row => row.appHeld),
    [3200, 0],
  );
  assert.deepEqual(
    rows.map(row => row.toolingOnly),
    [0, 1000],
  );
});

test('production paths label the selected strong edge at every hop', () => {
  const g = graph();
  const root = g.node(1, '(GC roots)', 0, 'synthetic');
  const win = g.node(5, 'Window / https://example.test', 100);
  const store = g.node(9, 'Store', 200);
  const payload = g.node(17, 'Array', 3000, 'array');
  g.edge(root, win, 'root');
  g.edge(win, store, 'weakStore', 'weak');
  g.edge(win, store, 'get __REACT_DEVTOOLS_GLOBAL_HOOK__');
  g.edge(win, store, 'app');
  g.edge(store, payload, 'weakItems', 'weak');
  g.edge(store, payload, 'items');
  root.dominatorNode = root;
  win.dominatorNode = root;
  store.dominatorNode = win;
  payload.dominatorNode = store;
  g.finish();
  const devRoots = collectDevRoots(g.snapshot);
  const reached = computeReachableWithoutDevRoots(g.snapshot, devRoots);
  const [row] = toolingSplit(g.snapshot, devRoots, reached, [17]);
  assert.equal(
    row.path,
    '(GC roots).root → Window / https://example.test.app → Store.items → @17',
  );
});

test('the verdict names a tooling-only part and a weak-only hold', () => {
  const snapshot = heap();
  const devRoots = collectDevRoots(snapshot);
  const reached = computeReachableWithoutDevRoots(snapshot, devRoots);
  const [win, store, held] = toolingSplit(
    snapshot,
    devRoots,
    reached,
    [5, 9, 11],
  );
  assert.match(toolingVerdict(win), /^mixed: a production path exists/);
  assert.match(toolingVerdict(store), /^app-held/);
  assert.equal(toolingVerdict(held), 'tooling-only');

  const g = graph();
  const root = g.node(1, '(GC roots)', 0, 'synthetic');
  const win2 = g.node(5, 'Window / https://example.test', 100);
  const cache = g.node(9, 'Cache', 200);
  g.edge(root, win2, 'root');
  g.edge(win2, cache, 'cache', 'weak');
  root.dominatorNode = root;
  win2.dominatorNode = root;
  cache.dominatorNode = win2;
  g.finish();
  const roots2 = collectDevRoots(g.snapshot);
  const [row] = toolingSplit(
    g.snapshot,
    roots2,
    computeReachableWithoutDevRoots(g.snapshot, roots2),
    [9],
  );
  assert.equal(row.path, null);
  assert.match(toolingVerdict(row), /^weakly held/);
});
