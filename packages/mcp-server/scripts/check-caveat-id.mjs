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
 * Unit tests for caveat ids (caveat-id.ts): the same id for a caveat in every
 * round of a sweep, whatever its counts.
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
const built = path.join(here, '..', 'dist', 'caveat-id.js');
if (!fs.existsSync(built)) {
  console.error('check-caveat-id: dist/caveat-id.js is missing; build first.');
  process.exit(1);
}
const {caveatId, caveatRef} = await import(pathToFileURL(built).href);

test('counts do not change the id; a different name does', () => {
  const a = caveatId(
    'DEAD PROP: web_memlab_fixes_4 is read by no served code (scanned 12/40)',
  );
  assert.equal(
    a,
    caveatId(
      'DEAD PROP: web_memlab_fixes_4 is read by no served code (scanned 31/40)',
    ),
  );
  assert.notEqual(
    a,
    caveatId(
      'DEAD PROP: web_memlab_fixes_5 is read by no served code (scanned 12/40)',
    ),
  );
  assert.match(a, /^[0-9a-f]{6}$/);
});

test('a reference is the id and the text cut short', () => {
  const ref = caveatRef('x'.repeat(100), 20);
  assert.match(ref, /^`#[0-9a-f]{6}` x{19}…$/);
});
