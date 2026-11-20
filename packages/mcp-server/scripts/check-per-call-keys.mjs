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
 * Unit tests for `perCallKeys` (tools/framework-buffers.ts): which wide tables
 * are keyed by a per-call counter rather than once per module.
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
const built = path.join(here, '..', 'dist', 'tools', 'framework-buffers.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-per-call-keys: dist/tools/framework-buffers.js is missing; build first.',
  );
  process.exit(1);
}
const {perCallKeys} = await import(pathToFileURL(built).href);

/** A table node whose property edges are `keys`. */
function table(keys) {
  return {
    references: keys.map(k => ({type: 'property', name_or_index: k})),
  };
}
const counted = n =>
  Array.from({length: n}, (_, i) => `__requireModule__Mod${i % 50}__${i + 1}`);
const named = n => Array.from({length: n}, (_, i) => `Module${i}.react`);

test('keys numbered by a per-call counter', () => {
  const keys = [...counted(2000), ...named(3000)];
  const c = perCallKeys(table(keys), keys.length);
  assert.equal(c.count, 2000);
  assert.equal(c.highest, 2000);
  assert.match(c.example, /__2000$/);
});

test('one stray large id does not hide the counter', () => {
  const keys = [...counted(2000), '__mod__2046346', ...named(3000)];
  const c = perCallKeys(table(keys), keys.length);
  assert.notEqual(c, null);
  assert.equal(c.count, 2000);
  assert.equal(c.highest, 2000);
});

test('many sparse ids among the counted keys do not hide it either', () => {
  const ids = Array.from({length: 500}, (_, i) => `__mod__${100000 + i * 977}`);
  const keys = [...counted(2000), ...ids];
  const c = perCallKeys(table(keys), keys.length);
  assert.equal(c.count, 2000);
});

test('sparse module ids are not a counter', () => {
  const keys = Array.from({length: 5000}, (_, i) => `cr:${1000 + i * 409}`);
  assert.equal(perCallKeys(table(keys), keys.length), null);
});

test('a handful of numbered keys is ordinary naming', () => {
  const keys = [...counted(50), ...named(5000)];
  assert.equal(perCallKeys(table(keys), keys.length), null);
});

test('separators are grouped apart', () => {
  // Dense `cr:` ids and a dense `__` counter: the larger group wins.
  const cr = Array.from({length: 1200}, (_, i) => `cr:${i}`);
  const keys = [...cr, ...counted(3000)];
  const c = perCallKeys(table(keys), keys.length);
  assert.equal(c.count, 3000);
  assert.match(c.example, /^__requireModule__/);
});
