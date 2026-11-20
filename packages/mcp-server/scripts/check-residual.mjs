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
 * Unit tests for `memlab_residual` (tools/residual.ts): per-label, combined,
 * shared and joint-only freed bytes on a fake heap graph.
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
const built = path.join(here, '..', 'dist', 'tools', 'residual.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-residual: dist/tools/residual.js is missing; build first.',
  );
  process.exit(1);
}
const {computeResidual, edgeSpecSplits, mergeNumberRows} = await import(
  pathToFileURL(built).href
);

/**
 * A fake snapshot. `spec` is [{id, name, type?, self}] and edges are
 * [fromIdx, toIdx, name, type?]. Node index = position in `spec`.
 */
function fakeSnapshot(spec, edgeSpec) {
  const edges = edgeSpec.map(([from, to, name, type = 'property'], i) => ({
    from,
    to,
    name,
    type,
    i,
  }));
  const snap = {};
  const nodeAt = idx => {
    const s = spec[idx];
    if (s == null) return null;
    return {
      id: s.id,
      name: s.name,
      type: s.type ?? 'object',
      self_size: s.self,
      nodeIndex: idx,
      forEachReference(cb) {
        for (const e of edges) if (e.from === idx && cb(edgeOf(e))?.stop) break;
      },
      forEachReferrer(cb) {
        for (const e of edges) if (e.to === idx && cb(edgeOf(e))?.stop) break;
      },
    };
  };
  const edgeOf = e => ({
    type: e.type,
    name_or_index: e.name,
    to_node: e.to,
    edgeIndex: e.i,
    get fromNode() {
      return nodeAt(e.from);
    },
    get toNode() {
      return nodeAt(e.to);
    },
  });
  snap.nodes = {
    length: spec.length,
    get: nodeAt,
    forEach(cb) {
      for (let i = 0; i < spec.length; i++) cb(nodeAt(i), i);
    },
  };
  snap.edges = {length: edges.length, get: i => edgeOf(edges[i])};
  snap.getNodeById = id => {
    const i = spec.findIndex(s => s.id === id);
    return i < 0 ? null : nodeAt(i);
  };
  return snap;
}

// roots -> A -> X <- B <- roots; roots -> H -y-> Y -> Z; H -weak-> W.
const SPEC = [
  {id: 3, name: '(GC roots)', type: 'synthetic', self: 0},
  {id: 11, name: 'A', self: 10},
  {id: 13, name: 'B', self: 20},
  {id: 15, name: 'H', self: 1},
  {id: 17, name: 'X', self: 100},
  {id: 19, name: 'Y', self: 50},
  {id: 21, name: 'Z', self: 500},
  {id: 23, name: 'W', self: 1000},
];
const EDGES = [
  [0, 1, 'a'],
  [0, 2, 'b'],
  [0, 3, 'h'],
  [1, 4, 'x'],
  [2, 4, 'x'],
  [3, 5, 'y'],
  [5, 6, 'z'],
  [3, 7, 'w', 'weak'],
];

function plan(labels, removed = [], byClass = []) {
  const p = {labels, removed: new Map(), byClass: new Map(), byNode: new Map()};
  for (const [idx, mask] of removed) p.removed.set(idx, mask);
  for (const [cls, prop, mask] of byClass) {
    if (!p.byClass.has(cls)) p.byClass.set(cls, new Map());
    p.byClass.get(cls).set(prop, mask);
  }
  return p;
}

test('per-label, combined, shared and joint-only bytes', () => {
  const snap = fakeSnapshot(SPEC, EDGES);
  const p = plan(
    ['A', 'B', 'H.y', 'Y'],
    [
      [1, 1],
      [2, 2],
      [5, 8],
    ],
    [['H', 'y', 4]],
  );
  const r = computeResidual(snap, p);
  // A, B, X, Y, Z; W was never strongly reachable.
  assert.equal(r.combined, 680);
  assert.deepEqual(r.alone, [10, 20, 550, 550]);
  assert.deepEqual(r.doors, [1, 1, 1, 1]);
  // Y and Z are freed by two single cuts; X only by A and B together.
  assert.equal(r.shared, 550);
  assert.equal(r.jointOnly, 100);
  assert.deepEqual([...r.after], [1, 0, 0, 1, 0, 0, 0, 0]);
});

test('one label: alone equals combined', () => {
  const snap = fakeSnapshot(SPEC, EDGES);
  const r = computeResidual(snap, plan(['H.y'], [], [['H', 'y', 1]]));
  assert.equal(r.combined, 550);
  assert.deepEqual(r.alone, [550]);
  assert.equal(r.jointOnly, 0);
});

test('an edge cut out of a holder freed by another cut still counts its doors', () => {
  const snap = fakeSnapshot(SPEC, EDGES);
  // Removing H hides H.y from the combined walk; its own walk must see it.
  const r = computeResidual(
    snap,
    plan(['H', 'H.y'], [[3, 1]], [['H', 'y', 2]]),
  );
  assert.deepEqual(r.doors, [1, 1]);
  assert.deepEqual(r.alone, [551, 550]);
  assert.equal(r.combined, 551);
});

test('the parent edge is the one that first reached a node', () => {
  const snap = fakeSnapshot(SPEC, EDGES);
  const r = computeResidual(snap, plan(['A'], [[1, 1]]));
  // X is reached only through B once A is cut: edge #4.
  assert.equal(r.parent[4], 4 + 1);
});

test('Class.prop splits at every dot', () => {
  assert.deepEqual(edgeSpecSplits('Object.history'), [['Object', 'history']]);
  assert.deepEqual(edgeSpecSplits('Window / https://x.com.foo'), [
    ['Window / https://x', 'com.foo'],
    ['Window / https://x.com', 'foo'],
  ]);
  assert.deepEqual(edgeSpecSplits('noDot'), []);
  assert.deepEqual(edgeSpecSplits('.x'), []);
});

test('heap-number holders of one record type fold into one row', () => {
  const rows = mergeNumberRows([
    {cls: 'Object', prop: 'sortIndex', count: 6268, bytes: 75216, sample: 1},
    {
      cls: 'Object',
      prop: 'expirationTime',
      count: 6268,
      bytes: 75216,
      sample: 1,
    },
    {cls: 'Object', prop: 'startTime', count: 7455, bytes: 89460, sample: 2},
    {cls: 'Bl', prop: 'lanes', count: 6268, bytes: 75216, sample: 3},
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].props, ['sortIndex', 'expirationTime']);
  assert.equal(rows[0].bytes, 150432);
  assert.equal(rows[1].prop, 'startTime');
});
