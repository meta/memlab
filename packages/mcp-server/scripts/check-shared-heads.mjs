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
 * Unit tests for `priorSharedHeads` (tools/retainer-summary.ts), which
 * `memlab_retainer_summary` and `memlab_trace_all` use to print a head shared
 * with an earlier path once.
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
const built = path.join(here, '..', 'dist', 'tools', 'retainer-summary.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-shared-heads: dist/tools/retainer-summary.js is missing; build first.',
  );
  process.exit(1);
}
const {priorSharedHeads} = await import(pathToFileURL(built).href);

test('each path names the earlier path it shares the longest head with', () => {
  const p = s => s.split('');
  assert.deepEqual(
    priorSharedHeads([
      p('abcdefX'),
      p('xyzQ'),
      p('abcdeY'),
      p('abZ'),
      p('xyzW'),
      p('abcdefXT'),
    ]),
    [
      null,
      null,
      {ref: 0, shared: 5},
      null,
      {ref: 1, shared: 3},
      {ref: 0, shared: 7},
    ],
  );
});

test('a path always keeps its last segment', () => {
  assert.deepEqual(
    priorSharedHeads([
      ['a', 'b', 'c', 'd'],
      ['a', 'b', 'c', 'd'],
    ]),
    [null, {ref: 0, shared: 3}],
  );
});
