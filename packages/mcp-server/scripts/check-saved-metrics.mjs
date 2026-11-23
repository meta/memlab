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
 * Unit tests for saved metrics (probe-sets.ts `saveMetric`,
 * `resolveMetricRef`, `expandMetricRefs`): `@name` references to probe code.
 *
 *   npm run build-pkg && npm run test-units
 *
 * Runs against the BUILT dist/, with a throwaway MEMLAB_STATE_DIR.
 */
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.join(here, '..', 'dist', 'probe-sets.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-saved-metrics: dist/probe-sets.js is missing; build first.',
  );
  process.exit(1);
}
process.env.MEMLAB_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'saved-metrics-'),
);
const {
  saveMetric,
  resolveMetricRef,
  expandMetricRefs,
  writeProbeSets,
  readProbeSets,
} = await import(pathToFileURL(built).href);

test('a saved metric runs alone: its prelude is inlined', () => {
  saveMetric('fl_reactions', 'result = n * 2;', 'const n = 21;');
  const ref = resolveMetricRef('@fl_reactions');
  assert.equal(ref.code, 'const n = 21;\n;\nresult = n * 2;');
  assert.equal(resolveMetricRef('result = 1;'), null);
});

test('@set.probe reads a probe set, with the set prelude and cap', () => {
  writeProbeSets({
    ...readProbeSets(),
    wa: {
      prelude: 'const k = 1;',
      probes: {seen: {code: 'result = k;', cap: 5}},
    },
  });
  assert.deepEqual(resolveMetricRef('@wa.seen'), {
    code: 'const k = 1;\n;\nresult = k;',
    cap: 5,
  });
  assert.deepEqual(
    expandMetricRefs({
      a: '@wa.seen',
      b: {code: '@fl_reactions'},
      c: 'result = 0;',
    }),
    {
      a: 'const k = 1;\n;\nresult = k;',
      b: {code: 'const n = 21;\n;\nresult = n * 2;', cap: undefined},
      c: 'result = 0;',
    },
  );
});

test('an unknown reference names the saved ones', () => {
  assert.throws(
    () => resolveMetricRef('@nope'),
    /No saved metric @nope\. Saved: @fl_reactions, @wa\.seen/,
  );
  assert.throws(() => saveMetric('bad name', 'x'), /not a metric name/);
});
