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
 * Unit tests for `elementSplit` (tools/collection-census.ts): what share of a
 * collection's elements is dead, by signature.
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
const built = path.join(here, '..', 'dist', 'tools', 'collection-census.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-collection-census: dist/tools/collection-census.js is missing; build first.',
  );
  process.exit(1);
}
const {elementSplit, formatSplit} = await import(pathToFileURL(built).href);

let nextId = 100;
function node(type, name, props = {}, extra = {}) {
  const references = Object.entries(props).map(([k, v]) => ({
    type: 'property',
    name_or_index: k,
    toNode: v,
  }));
  return {
    id: nextId++,
    type,
    name,
    references,
    retainedSize: 64,
    is_detached: false,
    isString: false,
    getReferenceNode(n) {
      return references.find(e => e.name_or_index === n)?.toNode ?? null;
    },
    ...extra,
  };
}
const NULL = node('hidden', 'null');
const UNDEF = node('hidden', 'undefined');
const fn = (name, captured) => {
  const c = node('closure', name);
  if (captured != null) {
    const ctx = node('hidden', 'system / Context');
    ctx.references.push({
      type: 'context',
      name_or_index: 'localFunc',
      toNode: captured,
    });
    c.references.push({
      type: 'internal',
      name_or_index: 'context',
      toNode: ctx,
    });
  }
  return c;
};
const task = live =>
  node('object', 'Object', {
    id: node('number', 'heap number'),
    callback: live ? fn('performWork') : NULL,
    sortIndex: node('number', 'heap number'),
    expirationTime: node('number', 'heap number'),
  });

test('cancelled Scheduler tasks are dead', () => {
  const elems = [...Array(95)]
    .map(() => task(false))
    .concat([...Array(5)].map(() => task(true)));
  const s = elementSplit(elems);
  assert.equal(s.tasks, 100);
  assert.equal(s.cancelledTasks, 95);
  assert.equal(s.dead, 95);
  assert.match(s.shapes[0].shape, /^\{id, callback, sortIndex, …\}$/);
  assert.match(formatSplit(s), /cancelled tasks 95%/);
});

test('wrappers around a shared no-op are dead; around a live function they are not', () => {
  const noop = fn('emptyFunction');
  const wrappers = [...Array(90)].map(() => fn('cancelableFunction', noop));
  const live = [...Array(10)].map(() =>
    fn('cancelableFunction', fn('onLeave')),
  );
  const s = elementSplit([...wrappers, ...live]);
  assert.deepEqual(s.sameFn, {n: 90, name: 'emptyFunction', noop: true});
  assert.equal(s.dead, 90);

  const shared = fn('dispatch');
  const t = elementSplit([...Array(50)].map(() => fn('bound', shared)));
  assert.equal(t.sameFn.noop, false);
  assert.equal(t.dead, 0);
  assert.match(formatSplit(t), /same captured fn 100% `dispatch`/);
});

test('a few closures sharing a capture are not reported', () => {
  const shared = fn('native_bind');
  const elems = [
    fn('a', shared),
    fn('b', shared),
    ...[...Array(17)].map(() => node('object', 'Array')),
  ];
  assert.equal(elementSplit(elems).sameFn, null);
});

test('null slots are dead in a list but not in a record', () => {
  const elems = [NULL, UNDEF, NULL, node('object', 'Foo')];
  assert.equal(elementSplit(elems).dead, 3);
  const rec = elementSplit(elems, 0, 4, false);
  assert.equal(rec.nullish, 3);
  assert.equal(rec.dead, 0);
});

test('detached DOM, holes and small integers', () => {
  const det = node('native', 'Detached HTMLDivElement');
  const s = elementSplit([det, det, null, node('object', 'Foo')], 4, 8);
  assert.equal(s.detached, 2);
  assert.equal(s.dead, 2);
  assert.equal(s.shapes.find(x => x.shape === 'smi').n, 1);
  assert.match(formatSplit(s), /holes\/smi 50%/);
  assert.match(formatSplit(s), /detached 50%/);
});

test('a Map keyed by detached elements', () => {
  const det = node('native', 'Detached HTMLDivElement');
  const vals = [...Array(4)].map(() => node('object', 'Object', {data: NULL}));
  const s = elementSplit(vals, 0, 4, true, [
    det,
    det,
    det,
    node('object', 'K'),
  ]);
  assert.equal(s.detached, 3);
  assert.equal(s.dead, 3);
});

test('a clean collection prints a dash', () => {
  const s = elementSplit(
    [...Array(10)].map(() => node('object', 'ConstUriImpl')),
  );
  assert.equal(formatSplit(s), '—');
  assert.deepEqual(s.shapes, [{shape: 'ConstUriImpl', n: 10}]);
});

test('large collections are sampled evenly', () => {
  const elems = [...Array(50_000)].map((_, i) =>
    i % 2 === 0 ? NULL : node('object', 'Foo'),
  );
  const s = elementSplit(elems);
  assert.ok(s.examined <= 20_000);
  assert.ok(Math.abs(s.nullish * 2 - s.examined) <= 1);
});
