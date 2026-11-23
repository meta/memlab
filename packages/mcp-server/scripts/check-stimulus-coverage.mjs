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
 * Unit tests for the sweep digest's stimulus coverage
 * (tools/round-digest.ts `stimulusCoverageLines`).
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
if (!fs.existsSync(path.join(dist, 'tools', 'round-digest.js'))) {
  console.error(
    'check-stimulus-coverage: dist/tools/round-digest.js is missing; build first.',
  );
  process.exit(1);
}
const {stimulusCoverageLines} = await import(
  pathToFileURL(path.join(dist, 'tools', 'round-digest.js')).href
);

const catalog = {
  hover: {area: 'list', stimuli: ['hover']},
  search: {area: 'list', stimuli: ['focus', 'keyboard']},
  typing: {area: 'composer', stimuli: ['keyboard']},
};

test('pairs no round drove are listed with the combos that drive them', () => {
  const lines = stimulusCoverageLines([
    {stimuli: {hover: catalog.hover}, stimulus_catalog: catalog},
    {
      stimuli: {
        typing: {area: 'composer', stimuli: ['keyboard', 'visibility']},
      },
      stimulus_catalog: catalog,
    },
  ]);
  assert.match(
    lines[0],
    /3 \(area × stimulus\) pair\(s\) driven; 2 the combos/,
  );
  assert.deepEqual(lines.slice(1), [
    '- list × focus — search',
    '- list × keyboard — search',
  ]);
});

test('a fully covered sweep says so, and old rounds add nothing', () => {
  const lines = stimulusCoverageLines([
    {stimuli: catalog, stimulus_catalog: catalog},
    {},
  ]);
  assert.deepEqual(lines, [
    '**Stimulus coverage:** 4 (area × stimulus) pair(s) driven.',
  ]);
  assert.deepEqual(stimulusCoverageLines([{}, {}]), []);
});
