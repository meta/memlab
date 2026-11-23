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
 * Unit tests for `growthVerdict` (tools/growth-check.ts).
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
const built = path.join(here, '..', 'dist', 'tools', 'growth-check.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-growth-check: dist/tools/growth-check.js is missing; build first.',
  );
  process.exit(1);
}
const {growthVerdict} = await import(pathToFileURL(built).href);

const ids = (from, n) => new Set(Array.from({length: n}, (_, i) => from + i));
const rung = (label, entries, retained, members, found = 'id') => ({
  label,
  found,
  entries,
  retained,
  members,
});

test('grows: more entries, old members kept', () => {
  const v = growthVerdict([
    rung('a', 100, 1000, ids(0, 100)),
    rung('b', 300, 3000, ids(0, 300)),
  ]);
  assert.equal(v.verdict, 'grows');
  assert.match(v.why, /rising at every rung/);
});

test('frozen: same members and size on every rung', () => {
  const v = growthVerdict([
    rung('a', 50, 5000, ids(0, 50)),
    rung('b', 50, 5000, ids(0, 50)),
    rung('c', 50, 5010, ids(0, 50)),
  ]);
  assert.equal(v.verdict, 'frozen');
});

test('turns over: same size, members replaced', () => {
  const v = growthVerdict([
    rung('a', 200, 9000, ids(0, 200)),
    rung('b', 205, 9100, ids(1000, 205)),
  ]);
  assert.equal(v.verdict, 'turns over');
});

test('shrinks', () => {
  assert.equal(
    growthVerdict([rung('a', 93, 1, ids(0, 93)), rung('b', 18, 1, ids(0, 18))])
      .verdict,
    'shrinks',
  );
});

test('one rung, or a holder only on the last rung, is not comparable', () => {
  assert.equal(
    growthVerdict([rung('a', 10, 1, ids(0, 10))]).verdict,
    'not comparable',
  );
  const v = growthVerdict([
    rung('a', null, 0, new Set(), null),
    rung('b', 10, 1, ids(0, 10)),
  ]);
  assert.equal(v.verdict, 'not comparable');
  assert.match(v.why, /created since/);
});

test('an object without entries is sized by retained bytes', () => {
  const v = growthVerdict([
    rung('a', null, 1000, ids(0, 5)),
    rung('b', null, 5000, ids(0, 9)),
  ]);
  assert.equal(v.verdict, 'grows');
  assert.match(v.why, /retained bytes/);
});
