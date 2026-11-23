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
 * Unit tests for Map/Set backing-store reading (utils.ts): deleted slots,
 * small-integer keys and key/value alignment.
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
const built = path.join(here, '..', 'dist', 'utils.js');
if (!fs.existsSync(built)) {
  console.error('check-map-slots: dist/utils.js is missing; build first.');
  process.exit(1);
}
const {
  collectionSlotCounts,
  enumerateMapEntries,
  enumerateSetElements,
  mapKeyResidue,
} = await import(pathToFileURL(built).href);

let nextId = 100;
const obj = (name, type = 'object') => ({
  id: nextId++,
  name,
  type,
  references: [],
});
const HOLE = {id: 50, name: 'system / Hole', type: 'hidden', references: []};

/** A Map/Set whose table has `slots` (index → node) after `buckets` heads. */
function collection(name, slots) {
  const table = obj('system / OrderedHashMap', 'array');
  table.references.push({
    type: 'internal',
    name_or_index: 'map',
    toNode: obj('system / Map', 'hidden'),
  });
  for (const [idx, node] of slots) {
    table.references.push({
      type: 'internal',
      name_or_index: String(idx),
      toNode: node,
    });
  }
  const c = obj(name);
  c.references.push({type: 'internal', name_or_index: 'table', toNode: table});
  return c;
}

// 4 buckets: entries start at 3 + 4 = 7, as [key, value, chain].
const entry = (k, key, value) => {
  const base = 7 + 3 * k;
  return [...(key ? [[base, key]] : []), ...(value ? [[base + 1, value]] : [])];
};

test('deleted entries are not counted, and are reported', () => {
  const a = obj('A');
  const b = obj('B');
  const m = collection('Map', [
    ...entry(0, obj('"k0"', 'string'), a),
    ...entry(1, HOLE, HOLE),
    ...entry(2, obj('"k2"', 'string'), b),
    ...entry(3, HOLE, HOLE),
  ]);
  const entries = enumerateMapEntries(m);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map(e => e.value),
    [a, b],
  );
  assert.deepEqual(collectionSlotCounts(m), {live: 2, deleted: 2});
});

test('small-integer keys leave the value as a value, with a null key', () => {
  // Five entries reach slot 20, past what a 2-bucket table holds (16), so
  // the table has 4 buckets and keys sit at index ≡ 7 (mod 3).
  const values = Array.from({length: 5}, () => obj('WeakRef'));
  const m = collection(
    'Map',
    values.flatMap((v, k) => entry(k, null, v)),
  );
  assert.equal(mapKeyResidue([8, 11, 14, 17, 20]), 7 % 3);
  const entries = enumerateMapEntries(m);
  assert.equal(entries.length, 5);
  for (const [i, e] of entries.entries()) {
    assert.equal(e.key, null);
    assert.equal(e.value, values[i]);
  }
});

test('small-integer values keep a null value', () => {
  const keys = [obj('"a"', 'string'), obj('"b"', 'string')];
  const m = collection('Map', [
    ...entry(0, keys[0], obj('X')),
    ...entry(1, keys[1], null),
  ]);
  const entries = enumerateMapEntries(m);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].key, keys[1]);
  assert.equal(entries[1].value, null);
});

test('a Set skips deleted slots and counts them', () => {
  const x = obj('X');
  const y = obj('Y');
  const s = collection('Set', [
    [5, x],
    [7, HOLE],
    [9, y],
  ]);
  assert.deepEqual(enumerateSetElements(s), [x, y]);
  assert.deepEqual(collectionSlotCounts(s), {live: 2, deleted: 1});
});

test('WeakMap dense two-slot entries keep every key and value', () => {
  const keys = Array.from({length: 4}, () => obj('Key'));
  const values = Array.from({length: 4}, () => obj('Value'));
  const m = collection(
    'WeakMap',
    keys.flatMap((key, i) => [
      [7 + 2 * i, key],
      [8 + 2 * i, values[i]],
    ]),
  );
  assert.deepEqual(
    enumerateMapEntries(m),
    keys.map((key, i) => ({key, value: values[i]})),
  );
  assert.deepEqual(collectionSlotCounts(m), {live: 4, deleted: 0});
});

test('WeakMap preserves inline values and counts deleted pairs', () => {
  const a = obj('A');
  const b = obj('B');
  const c = obj('C');
  const value = obj('Value');
  const m = collection('WeakMap', [
    [7, a],
    [9, HOLE],
    [10, HOLE],
    [11, b],
    [12, value],
    [13, c],
    [15, HOLE],
    [16, HOLE],
  ]);
  assert.deepEqual(enumerateMapEntries(m), [
    {key: a, value: null},
    {key: b, value},
    {key: c, value: null},
  ]);
  assert.deepEqual(collectionSlotCounts(m), {live: 3, deleted: 2});
});

test('alignment is unknown when nothing pins it', () => {
  assert.equal(mapKeyResidue([]), null);
  // Three lone slots fit both "SMI keys, 4 buckets" and "SMI values, 2 buckets".
  assert.equal(mapKeyResidue([8, 11, 14]), null);
});
