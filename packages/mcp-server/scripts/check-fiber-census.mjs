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
 * Unit tests for `fiberCensus` (tools/fiber-census.ts): lists in the
 * committed fiber tree, rendered vs collapsed items, per-item multipliers.
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
const built = path.join(here, '..', 'dist', 'tools', 'fiber-census.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-fiber-census: dist/tools/fiber-census.js is missing; build first.',
  );
  process.exit(1);
}
const {bucketSizes, fiberCensus, fiberCensusSweepSection, isNamedComponent} =
  await import(pathToFileURL(built).href);

let nextId = 11;
const all = [];
function node(type, name) {
  const n = {id: nextId++, type, name, references: [], referrers: []};
  if (type === 'string') {
    n.isString = true;
    n.toStringNode = () => ({stringValue: name});
  }
  all.push(n);
  return n;
}
function link(from, name, to) {
  from.references.push({type: 'property', name_or_index: name, toNode: to});
}
const closures = new Map();
/** A fiber rendering component `name` (a string for a host element). */
function fiber(name, children = []) {
  const f = node('object', 'FiberNode');
  if (name != null) {
    let et = closures.get(name);
    if (et == null) {
      et = name.startsWith('<')
        ? node('string', name.slice(1, -1))
        : node('closure', name);
      closures.set(name, et);
    }
    link(f, 'elementType', et);
  }
  link(f, 'memoizedProps', node('object', 'Object'));
  link(f, 'stateNode', node('object', 'Object'));
  children.forEach((c, i) => {
    if (i === 0) link(f, 'child', c);
    else link(children[i - 1], 'sibling', c);
    link(c, 'return', f);
  });
  return f;
}
const snapshotOf = nodes => ({nodes: {forEach: fn => nodes.forEach(fn)}});

/** 20 collapsed shells, then 10 rendered items with 4 decoys each. */
function feed() {
  all.length = 0;
  const items = [];
  for (let i = 0; i < 20; i++) items.push(fiber('Item', [fiber('Shell')]));
  for (let i = 0; i < 10; i++) {
    const decoys = [0, 1, 2, 3].map(() => fiber('Decoy', [fiber('<div>')]));
    items.push(fiber('Item', [fiber('Body', decoys)]));
  }
  const root = fiber(null, [fiber('Feed', items)]);
  const container = node('object', 'FiberRootNode');
  link(container, 'containerInfo', node('native', 'HTMLDivElement'));
  link(container, 'current', root);
  return snapshotOf(all);
}

test('bucketSizes splits rendered items from shells, in order', () => {
  const b = bucketSizes([42, 42, 43, 2500, 3000]);
  assert.equal(b.length, 2);
  assert.deepEqual(
    b.map(x => [x.count, x.min, x.max]),
    [
      [3, 42, 43],
      [2, 2500, 3000],
    ],
  );
  assert.deepEqual(b[0].range, [1, 3]);
  assert.deepEqual(b[1].range, [4, 5]);
  assert.equal(bucketSizes([10, 900, 11])[0].range, null);
});

test('host and anonymous types are not component names', () => {
  assert.equal(isNamedComponent('CometFeedUnit'), true);
  assert.equal(isNamedComponent('<div>'), false);
  assert.equal(isNamedComponent('{symbol}'), false);
  assert.equal(isNamedComponent('(root/fragment)'), false);
});

test('a list: 10 of 30 items rendered, 4 decoys per rendered item', () => {
  const c = fiberCensus(feed());
  assert.equal(c.mounted, 1 + 1 + 20 * 2 + 10 * (2 + 8));
  assert.equal(c.groups.length, 1);
  const g = c.groups[0];
  assert.equal(g.items, 30);
  assert.equal(g.rendered, 10);
  assert.deepEqual(
    g.buckets.map(b => [b.count, b.min, b.range]),
    [
      [20, 2, [1, 20]],
      [10, 10, [21, 30]],
    ],
  );
  assert.deepEqual(g.buckets[1].marks, ['Body', 'Decoy']);
  const decoy = g.rows.find(r => r.name === 'Decoy');
  assert.ok(decoy != null);
  assert.equal(decoy.total, 40);
  assert.equal(decoy.perMin, 4);
  assert.equal(decoy.perMax, 4);
  assert.equal(decoy.inOthers, 0);
  assert.equal(decoy.subtree, 2);
  assert.equal(decoy.holder, 'Body');
  // Body wraps most of every rendered item: structure, not a row.
  assert.equal(
    g.rows.some(r => r.name === 'Body'),
    false,
  );
});

test('earlier ladder rungs report a known list at any size', () => {
  const key = fiberCensus(feed()).groups[0].key;
  all.length = 0;
  const one = fiber('Item', [
    fiber('Body', [fiber('Decoy', [fiber('<div>')])]),
  ]);
  const root = fiber(null, [fiber('Feed', [one])]);
  const container = node('object', 'FiberRootNode');
  link(container, 'containerInfo', node('native', 'HTMLDivElement'));
  link(container, 'current', root);
  const s = snapshotOf(all);
  assert.equal(fiberCensus(s).groups.length, 0);
  const g = fiberCensus(s, {keys: new Set([key]), rows: 1e4}).groups[0];
  assert.equal(g.items, 1);
});

test('no fiber tree: the sweep section is empty', () => {
  all.length = 0;
  node('object', 'Object');
  assert.equal(fiberCensus(snapshotOf(all)).mounted, 0);
  assert.deepEqual(fiberCensusSweepSection(snapshotOf(all)), []);
  assert.ok(fiberCensusSweepSection(feed()).join('\n').includes('Decoy'));
});
