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
 * Unit tests for the battery's per-step timing line
 * (tools/analysis-battery.ts `slowestLine`).
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
const built = path.join(here, '..', 'dist', 'tools', 'analysis-battery.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-battery-timings: dist/tools/analysis-battery.js is missing; build first.',
  );
  process.exit(1);
}
const {slowestLine} = await import(pathToFileURL(built).href);

const t = (tool, ms, status = 'ok') => ({
  tool,
  elapsed_ms: ms,
  chars: 10,
  status,
});

test('the three slowest steps that ran, with the total', () => {
  const line = slowestLine([
    t('a', 120_000),
    t('b', 4_200),
    t('c', 61_000, 'error'),
    t('d', 500),
    t('e', 0, 'skipped'),
  ]);
  assert.equal(
    line,
    "**Slowest:** `a` 120 s · `c` 61 s · `b` 4.2 s, of 186 s in 4 steps (every step's time is in `battery.done.json` `timings`).",
  );
  assert.equal(slowestLine([t('x', 0, 'skipped')]), null);
});
