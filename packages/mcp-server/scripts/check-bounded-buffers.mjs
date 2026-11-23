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
 * Unit tests for capped browser buffers (bounded-buffers.ts `boundedFill`),
 * which `memlab_settle_check` and `memlab_blink_native_census` share.
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
const built = path.join(here, '..', 'dist', 'bounded-buffers.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-bounded-buffers: dist/bounded-buffers.js is missing; build first.',
  );
  process.exit(1);
}
const {boundedFill} = await import(pathToFileURL(built).href);

test('console message storage fills to 1,000 and says when', () => {
  const fill = boundedFill('blink::ConsoleMessage', 10, 646, 100);
  assert.equal(fill.cap, 1000);
  assert.equal(fill.saturatesAtCycle, 156);
  assert.equal(
    boundedFill('blink::SourceLocation', 0, 1000, 100).saturatesAtCycle,
    null,
  );
});

test('past the cap, or not a buffer, is not bounded', () => {
  assert.equal(boundedFill('blink::SourceLocation', 0, 1500, 100), null);
  assert.equal(boundedFill('blink::Node', 0, 10, 100), null);
  assert.equal(
    boundedFill('PerformanceEventTiming', 0, 140, null).saturatesAtCycle,
    null,
  );
});
