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
 * Unit tests for `getAnalysisTimeoutMs` (analysis-budget.ts).
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
const built = path.join(here, '..', 'dist', 'analysis-budget.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-analysis-budget: dist/analysis-budget.js is missing; build first.',
  );
  process.exit(1);
}
const {
  activeTimeoutMs_,
  beginAnalysisBudget,
  endAnalysisBudget,
  getAnalysisTimeoutMs,
  scaleBudgetToHeap,
} = await import(pathToFileURL(built).href);

test('default is 90 s, scaled by the active node count past 10M nodes', () => {
  delete process.env.MEMLAB_ANALYSIS_TIMEOUT_MS;
  assert.equal(getAnalysisTimeoutMs(), 90_000);
  assert.equal(getAnalysisTimeoutMs(undefined, 3_000_000), 90_000);
  assert.equal(getAnalysisTimeoutMs(undefined, 26_000_000), 234_000);
});

test('a per-call override wins, then the env var', () => {
  process.env.MEMLAB_ANALYSIS_TIMEOUT_MS = '5000';
  assert.equal(getAnalysisTimeoutMs(undefined, 26_000_000), 5000);
  assert.equal(getAnalysisTimeoutMs(1234, 26_000_000), 1234);
  assert.equal(getAnalysisTimeoutMs(0, 26_000_000), 0);
  process.env.MEMLAB_ANALYSIS_TIMEOUT_MS = '0';
  assert.equal(getAnalysisTimeoutMs(undefined, 26_000_000), 0);
  delete process.env.MEMLAB_ANALYSIS_TIMEOUT_MS;
});

test('a default budget widens to the heap the call walks', () => {
  delete process.env.MEMLAB_ANALYSIS_TIMEOUT_MS;
  beginAnalysisBudget(90_000, true);
  scaleBudgetToHeap(3_000_000);
  assert.equal(activeTimeoutMs_(), 90_000);
  scaleBudgetToHeap(26_000_000);
  assert.equal(activeTimeoutMs_(), 234_000);
  scaleBudgetToHeap(12_000_000);
  assert.equal(activeTimeoutMs_(), 234_000);
  endAnalysisBudget();
});

test('an explicit or re-armed budget is never widened', () => {
  delete process.env.MEMLAB_ANALYSIS_TIMEOUT_MS;
  beginAnalysisBudget(5000);
  scaleBudgetToHeap(26_000_000);
  assert.equal(activeTimeoutMs_(), 5000);
  beginAnalysisBudget(90_000, true);
  beginAnalysisBudget(60_000);
  scaleBudgetToHeap(26_000_000);
  assert.equal(activeTimeoutMs_(), 60_000);
  beginAnalysisBudget(0, true);
  scaleBudgetToHeap(26_000_000);
  assert.equal(activeTimeoutMs_(), 0);
  endAnalysisBudget();
});
