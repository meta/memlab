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
 * Unit tests for `withProbeSetCode` (probe-set-code.ts): a saved probe set
 * run across a ladder with no inline code.
 *
 *   npm run build-pkg && npm run test-units
 *
 * Runs against the BUILT dist/.
 */
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'node:vm';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.join(here, '..', 'dist', 'probe-set-code.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-probe-set-code: dist/probe-set-code.js is missing; build first.',
  );
  process.exit(1);
}
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'memlab-probes-'));
process.env.MEMLAB_STATE_DIR = state;
fs.writeFileSync(
  path.join(state, 'probes.json'),
  JSON.stringify({
    version: 1,
    sets: {
      fam: {
        run_dir: '/rounds/r7',
        probes: {
          a: {code: 'result = 1 + 1;'},
          b: {code: 'var result = 7;'},
          c: {code: 'let result = 9;'},
        },
      },
      lib: {prelude: 'const two = 2;', probes: {}},
      other: {
        probes: {
          a: {code: 'result = 5;'},
          boom: {code: 'result = null.id;'},
          bad: {code: 'result = ;'},
        },
      },
      special: {probes: {['__proto__']: {code: 'result = 11;'}}},
      failures: {
        probes: {
          first: {code: 'throw new Error("first failed");'},
          before: {code: 'result = 3;'},
          middle: {code: 'throw "middle failed";'},
          empty: {code: 'throw null;'},
          after: {code: 'let result = 5;'},
        },
      },
    },
  }),
);
const {withProbeSetCode} = await import(pathToFileURL(built).href);

test('the probes become the code, one key per probe', () => {
  const out = withProbeSetCode({use: ['fam', 'lib'], format: 'sections'});
  assert.equal(out.format, 'table');
  assert.equal(out.run_dir, '/rounds/r7');
  assert.deepEqual(out.use, ['lib']);
  const ctx = {result: undefined};
  vm.runInNewContext(out.code, ctx);
  assert.deepEqual({...ctx.result}, {a: 2, b: 7, c: 9});
});

test('an unknown set name is refused, even alongside valid sets', () => {
  for (const use of [
    ['famm'],
    ['fam', 'famm'],
    ['famm', 'lib'],
    ['toString'],
  ]) {
    assert.throws(
      () => withProbeSetCode({use}),
      /No saved probe set named "(famm|toString)"/,
    );
  }
});

test('a failing probe costs its own cell; the probes after it still run', () => {
  const ctx = {result: undefined};
  vm.runInNewContext(withProbeSetCode({use: ['failures']}).code, ctx);
  assert.deepEqual(
    {...ctx.result},
    {
      first: 'error: first failed',
      before: 3,
      middle: 'error: middle failed',
      empty: 'error: null',
      after: 5,
    },
  );
});

test('a probe named like a prototype key stays an ordinary key', () => {
  const ctx = {result: undefined};
  vm.runInNewContext(withProbeSetCode({use: ['special']}).code, ctx);
  assert.equal(Object.hasOwn(ctx.result, '__proto__'), true);
  assert.equal(ctx.result.__proto__, 11);
});

test('several sets: keys are qualified; a throwing or unparsable probe costs one cell', () => {
  const out = withProbeSetCode({use: ['fam', 'other']});
  const ctx = {result: undefined};
  vm.runInNewContext(out.code, ctx);
  const r = {...ctx.result};
  assert.equal(r['fam/a'], 2);
  assert.equal(r['other/a'], 5);
  assert.match(r['other/boom'], /^error: /);
  assert.match(r['other/bad'], /^error: does not parse/);
  assert.equal(r['fam/c'], 9);
});

test('inline code, an explicit target, or no probes leave the call alone', () => {
  const inline = {use: ['fam'], code: 'result = 3;'};
  assert.equal(withProbeSetCode(inline), inline);
  assert.equal(
    withProbeSetCode({use: ['fam'], paths: ['/x.heapsnapshot']}).run_dir,
    undefined,
  );
  const none = {use: ['lib']};
  assert.equal(withProbeSetCode(none), none);
});
