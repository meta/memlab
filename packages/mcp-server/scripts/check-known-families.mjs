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
 * Unit tests for known-families.ts: the families file and the leak report's
 * "Known families" table.
 *
 *   npm run build-pkg && npm run test-units
 *
 * Runs against the BUILT dist/.
 */
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.join(here, '..', 'dist', 'known-families.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-known-families: dist/known-families.js is missing; build first.',
  );
  process.exit(1);
}
const {loadFamilies, familiesSection} = await import(pathToFileURL(built).href);

const write = body => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'families-')),
    'families.json',
  );
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
};

test('loadFamilies reads a valid file and refuses a malformed one', () => {
  const ok = write({
    families: [{id: 'a', label: 'A', shapes: [['x', 'y']], status: 'known'}],
  });
  assert.equal(loadFamilies(ok)[0].id, 'a');
  assert.throws(() => loadFamilies(write({families: [{id: 'a'}]})), /family 0/);
  assert.throws(() => loadFamilies(write([])), /expected/);
});

test('familiesSection rates each family and names what is left unexplained', () => {
  const family = {
    id: 'a',
    label: 'A',
    shapes: [['x']],
    status: 'known',
    finding: 'r1',
  };
  const lines = familiesSection(
    '/tmp/families.json',
    [{family, counts: [10, 60, 110]}],
    [1000, 1200, 1400],
    100,
  );
  assert.equal(lines[0], '### Known families (families.json)');
  assert.ok(
    lines.includes('| A (`a`) | 10 | 60 | 110 | +100 | 1.00 | known | r1 |'),
  );
  assert.ok(
    lines.some(l =>
      l.startsWith(
        'Known families explain 100 of the 400 new plain objects (25%). **300 are NEW**',
      ),
    ),
  );
});

test('a rung without an index shows ? and no rate', () => {
  const family = {id: 'a', label: 'A', shapes: [['x']]};
  const lines = familiesSection(
    'f.json',
    [{family, counts: [null, 5]}],
    [null, 9],
    10,
  );
  assert.ok(lines.includes('| A (`a`) | ? | 5 | ? |  |  |  |'));
});
