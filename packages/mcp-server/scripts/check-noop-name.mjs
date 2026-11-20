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
 * Unit tests for `isNoopName` (tools/framework-buffers.ts): which wrapped
 * function names let framework_buffers say a listener array is full of
 * entries cancelled in place.
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
    'check-noop-name: dist/tools/framework-buffers.js is missing; build first.',
  );
  process.exit(1);
}
const {isNoopName} = await import(pathToFileURL(built).href);

test('shared no-ops', () => {
  for (const name of [
    'emptyFunction',
    'noop',
    'Noop',
    'NOOP',
    'noOp',
    '_noop',
    'nop',
  ]) {
    assert.equal(isNoopName(name), true, name);
  }
});

test('names that may do work', () => {
  for (const name of [
    'empty',
    'emptyList',
    'noopOnServer',
    'noopTimeout',
    'logNoop',
    'handleNoop',
    'onBeforeUnload',
    '(anonymous)',
    '',
  ]) {
    assert.equal(isNoopName(name), false, name);
  }
});
