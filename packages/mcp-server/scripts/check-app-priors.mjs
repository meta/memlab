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
 * Unit tests for MEMLAB_NO_APP_PRIORS (app-priors.ts, dev-modules.ts).
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
const dist = path.join(here, '..', 'dist');
if (!fs.existsSync(path.join(dist, 'app-priors.js'))) {
  console.error('check-app-priors: dist/ is missing; build first.');
  process.exit(1);
}
const {appPriorsEnabled, appPriorsNote} = await import(
  pathToFileURL(path.join(dist, 'app-priors.js')).href
);
const {classifyModuleName} = await import(
  pathToFileURL(path.join(dist, 'dev-modules.js')).href
);

test('on by default; MEMLAB_NO_APP_PRIORS=1 turns them off', () => {
  delete process.env.MEMLAB_NO_APP_PRIORS;
  assert.equal(appPriorsEnabled(), true);
  assert.equal(appPriorsNote(), null);
  process.env.MEMLAB_NO_APP_PRIORS = '1';
  assert.equal(appPriorsEnabled(), false);
  assert.match(appPriorsNote(), /App priors are OFF/);
  delete process.env.MEMLAB_NO_APP_PRIORS;
});

test('app-named dev modules are classified only with the priors on', () => {
  delete process.env.MEMLAB_NO_APP_PRIORS;
  assert.equal(classifyModuleName('CometDevToolsPanel').dev, true);
  assert.equal(classifyModuleName('CometRedblockInst').gated, true);
  process.env.MEMLAB_NO_APP_PRIORS = '1';
  assert.equal(classifyModuleName('CometDevToolsPanel').dev, false);
  assert.notEqual(classifyModuleName('CometRedblockInst').gated, true);
  // Generic rules still apply.
  assert.equal(classifyModuleName('ReactDevToolsBackend').dev, true);
  assert.equal(classifyModuleName('SomeDebugConsole').gated, true);
  delete process.env.MEMLAB_NO_APP_PRIORS;
});
