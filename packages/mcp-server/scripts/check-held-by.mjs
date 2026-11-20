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
 * Unit tests for `heldByLabel` (utils.ts): the `Held by` column of the
 * top-object tables.
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
  console.error('check-held-by: dist/utils.js is missing; build first.');
  process.exit(1);
}
const {heldByLabel} = await import(pathToFileURL(built).href);

let nextId = 1;
function node(name, type = 'object') {
  return {id: nextId++, name, type, referrers: [], references: []};
}
function edge(from, to, type, name) {
  const e = {fromNode: from, toNode: to, type, name_or_index: name};
  to.referrers.push(e);
  from.references.push(e);
  return e;
}

test('the edge from the dominator wins', () => {
  const store = node('RelayModernStore');
  const other = node('Other');
  const row = node('RelayRecordSource');
  edge(other, row, 'property', 'records');
  edge(store, row, 'property', '$13');
  row.dominatorNode = store;
  assert.equal(heldByLabel(row), 'RelayModernStore.$13');
});

test('no single owner: first holder and a count of the others', () => {
  const a = node('system / Context', 'object');
  const b = node('system / Context', 'object');
  const row = node('Object');
  edge(a, row, 'context', 'interaction');
  edge(b, row, 'context', 'pending');
  row.dominatorNode = node('(GC roots)', 'synthetic');
  assert.equal(heldByLabel(row), 'closure var interaction (+1)');
});

test('weak and shortcut edges are skipped', () => {
  const map = node('WeakMap');
  const holder = node('Cache');
  const row = node('Object');
  edge(map, row, 'weak', 'k');
  edge(holder, row, 'property', 'entry');
  row.dominatorNode = null;
  assert.equal(heldByLabel(row), 'Cache.entry');
});

test('a holder with no name does not throw', () => {
  const script = node(undefined, 'code');
  const src = node('string', 'string');
  edge(script, src, 'internal', 'source');
  src.dominatorNode = script;
  assert.equal(heldByLabel(src), 'source of script');

  const anon = node(undefined);
  const row = node('Object');
  edge(anon, row, 'property', 'cache');
  row.dominatorNode = anon;
  assert.equal(heldByLabel(row), '(anonymous).cache');

  const fn = node(undefined, 'closure');
  const ctx = node('system / Context');
  edge(fn, ctx, 'internal', 'context');
  ctx.dominatorNode = null;
  assert.equal(heldByLabel(ctx), 'closure (anonymous)');
});

test('a script source string is labelled by its file', () => {
  const script = node('/srv/app/dist/server-with-ws.js', 'code');
  const src = node('string', 'string');
  edge(script, src, 'internal', 'source');
  src.dominatorNode = script;
  assert.equal(heldByLabel(src), 'source of server-with-ws.js');
});

test('long labels are cut to maxLen', () => {
  const holder = node('A'.repeat(60));
  const row = node('Object');
  edge(holder, row, 'property', 'x');
  row.dominatorNode = holder;
  const l = heldByLabel(row, 20);
  assert.equal(l.length, 20);
  assert.ok(l.endsWith('…'));
});
