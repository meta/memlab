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
 * Unit tests for `evalErrorHint` (eval-hints.ts): the error messages seen in
 * agent transcripts each get their fix.
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
const built = path.join(here, '..', 'dist', 'eval-hints.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-eval-error-hints: dist/eval-hints.js is missing; build first.',
  );
  process.exit(1);
}
const {evalErrorHint} = await import(pathToFileURL(built).href);

const cases = [
  [
    'TypeError: byField[e.name_or_index].push is not a function',
    /Object\.prototype/,
  ],
  [
    "TypeError: Cannot read properties of undefined (reading 'push')",
    /initialise/,
  ],
  [
    "TypeError: Cannot read properties of null (reading 'references')",
    /not in THIS snapshot/,
  ],
  [
    "TypeError: Cannot read properties of null (reading 'id')",
    /not in THIS snapshot/,
  ],
  [
    "TypeError: Cannot read properties of undefined (reading 'fromNode')",
    /past the end/,
  ],
  ['TypeError: ids.filter is not a function', /not an array/],
  ['TypeError: snapshot.nodes.filter is not a function', /nodes\.forEach/],
  [
    "TypeError: Cannot read properties of undefined (reading 'add')",
    /g = new Set\(\)\)\); g\.add\(x\)/,
  ],
  [
    "TypeError: Cannot read properties of undefined (reading 'push')",
    /Object\.create\(null\)/,
  ],
  [
    'TypeError: (x.value.name || x.value).toString is not a function',
    /String\(x\)/,
  ],
];

for (const [message, want] of cases) {
  test(message, () => {
    assert.match(evalErrorHint(message) ?? '', want);
  });
}

test('an unrelated error gets no hint', () => {
  assert.equal(evalErrorHint('RangeError: Invalid array length'), null);
});

test('an undefined `.type` is not blamed on edge indexing', () => {
  assert.equal(
    evalErrorHint(
      "TypeError: Cannot read properties of undefined (reading 'type')",
    ),
    null,
  );
});

test('the snapshot.nodes hint does not suggest Array.from', () => {
  assert.doesNotMatch(
    evalErrorHint('TypeError: snapshot.nodes.map is not a function') ?? '',
    /Wrap it with `Array\.from/,
  );
});
