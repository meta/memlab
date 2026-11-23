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
 * Unit tests for `composeQueries` (tools/eval.ts): `memlab_eval({queries})`.
 *
 *   npm run build-pkg && npm run test-units
 *
 * Runs against the BUILT dist/.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.join(here, '..', 'dist', 'tools', 'eval.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-eval-queries: dist/tools/eval.js is missing; build first.',
  );
  process.exit(1);
}
const {composeQueries} = await import(pathToFileURL(built).href);

const run = queries => {
  const ctx = {result: undefined};
  vm.runInNewContext(composeQueries(queries), ctx);
  // A plain copy: the sandbox realm has its own Object prototype.
  return JSON.parse(JSON.stringify(ctx.result));
};

test('each query answers by `result =` or `return`, keyed by name', () => {
  assert.deepEqual(
    run([
      {name: 'a', code: 'result = 1 + 1;'},
      {name: 'b', code: 'return [1, 2, 3].length;'},
      {name: 'c', code: 'const x = 5; result = x * 2;'},
    ]),
    {a: 2, b: 3, c: 10},
  );
});

test('a throwing query reports its error and the rest still run', () => {
  const out = run([
    {name: 'bad', code: 'null.x;'},
    {name: 'good', code: 'return "ok";'},
  ]);
  assert.match(out.bad.error, /Cannot read properties of null/);
  assert.equal(out.good, 'ok');
});

test("queries do not see each other's locals", () => {
  const out = run([
    {name: 'a', code: 'const shared = 1; return shared;'},
    {name: 'b', code: 'return typeof shared;'},
  ]);
  assert.deepEqual(out, {a: 1, b: 'undefined'});
});
