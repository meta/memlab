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
 * Unit tests for the sweep digest's positive-control line
 * (tools/round-digest.ts `sweepPositiveControl`).
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
const built = path.join(here, '..', 'dist', 'tools', 'round-digest.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-sweep-control: dist/tools/round-digest.js is missing; build first.',
  );
  process.exit(1);
}
const {sweepPositiveControl} = await import(pathToFileURL(built).href);

const control = verdict => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-control-'));
  fs.mkdirSync(path.join(dir, 'r1'));
  fs.writeFileSync(
    path.join(dir, 'positive_control.json'),
    JSON.stringify({
      round: 'r434',
      tool: 'memlab_react_update_queues',
      match: 'Tooltip',
      min_per_cycle: 1,
      observed_per_cycle: null,
      ...verdict,
    }),
  );
  return sweepPositiveControl([path.join(dir, 'r1')]);
};

test('a control that fired only in another round is misconfigured, not void', () => {
  const line = control({
    status: 'MISCONFIGURED',
    fired_in: {round: 'r435', observed_per_cycle: 131.6},
  });
  assert.match(
    line,
    /Positive control misconfigured.*fired in r435 at 131\.6\/cycle.*not void/,
  );
});

test('VOID and PASS read as before', () => {
  assert.match(control({status: 'VOID'}), /SWEEP VOID/);
  assert.match(
    control({status: 'PASS', observed_per_cycle: 2}),
    /Positive control: PASS/,
  );
});
