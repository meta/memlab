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
 * Unit tests for `classifyRealmList` (realm-tags.ts).
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
const built = path.join(here, '..', 'dist', 'realm-tags.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-realm-tags: dist/realm-tags.js is missing; build first.',
  );
  process.exit(1);
}
const {classifyRealmList} = await import(pathToFileURL(built).href);

const ctx = (ordinal, label, attributedSize, detached = false) => ({
  ordinal,
  id: ordinal,
  label,
  detached,
  selfSize: 0,
  retainedSize: 0,
  attributedSize,
  attributedCount: 0,
});

test('the largest web realm is the page; others are classified against it', () => {
  const {page, kinds} = classifyRealmList([
    ctx(1, 'https://app.example.com', 100),
    ctx(2, 'https://app.example.com/frame', 10),
    ctx(3, 'chrome-extension://abcdef', 50),
    ctx(4, 'devtools://devtools/bundled', 5),
    ctx(5, 'https://ads.other.test', 5),
    ctx(6, '', 1),
    ctx(7, 'https://app.example.com', 999, true),
  ]);
  assert.equal(page, 1);
  assert.equal(kinds.get(1), 'page');
  assert.equal(kinds.get(2), 'secondary');
  assert.equal(kinds.get(3), 'extension');
  assert.equal(kinds.get(4), 'devtools');
  assert.equal(kinds.get(5), 'cross-origin');
  assert.equal(kinds.get(6), 'untagged');
  assert.equal(kinds.get(7), 'detached');
});

test('an extension never becomes the page, even when it owns the most', () => {
  const {page} = classifyRealmList([
    ctx(1, 'chrome-extension://big', 900),
    ctx(2, 'https://app.example.com', 10),
  ]);
  assert.equal(page, 2);
});

test('with no tags, the largest untagged realm is the page', () => {
  const {page, kinds} = classifyRealmList([ctx(1, '', 5), ctx(2, '', 50)]);
  assert.equal(page, 2);
  assert.equal(kinds.get(1), 'untagged');
});
