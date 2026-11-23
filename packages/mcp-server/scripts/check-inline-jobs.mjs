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
 * Unit tests for the inline-instead-of-job rule (tools/jobs.ts).
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
const built = path.join(here, '..', 'dist', 'tools', 'jobs.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-inline-jobs: dist/tools/jobs.js is missing; build first.',
  );
  process.exit(1);
}
const {
  INLINE_JOB_BUDGET_MS,
  predictLoadMs,
  predictEvalMs,
  prependNote,
  ranInlineNote,
} = await import(pathToFileURL(built).href);

test('load predictions bracket measured loads', () => {
  // Measured on a devvm: 3.6M nodes / 17.4M edges loaded in 16 s, 10.7M / 52.0M in 48 s.
  assert.ok(
    predictLoadMs({nodeCount: 3_620_601, edgeCount: 17_440_953}) <
      INLINE_JOB_BUDGET_MS,
  );
  assert.ok(
    predictLoadMs({nodeCount: 10_674_359, edgeCount: 51_977_928}) <
      INLINE_JOB_BUDGET_MS,
  );
  // 26M nodes / 118M edges: about 3 minutes, so it stays a job.
  assert.ok(
    predictLoadMs({nodeCount: 25_900_000, edgeCount: 118_000_000}) >
      INLINE_JOB_BUDGET_MS,
  );
});

test('eval runs inline below ~20M nodes', () => {
  assert.ok(predictEvalMs(10_000_000) < INLINE_JOB_BUDGET_MS);
  assert.ok(predictEvalMs(26_000_000) > INLINE_JOB_BUDGET_MS);
});

test('the note goes ahead of the first text block', () => {
  const r = prependNote(
    {content: [{type: 'text', text: 'body'}]},
    ranInlineNote(12_000),
  );
  assert.match(r.content[0].text, /^_Ran inline .* ~12 s.*\n\nbody$/s);
  assert.deepEqual(prependNote({content: []}, 'x'), {content: []});
});
