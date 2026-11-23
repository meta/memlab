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
const {arrayMethodMisuse, composeQueries, protoKeyTrap} = await import(
  pathToFileURL(built).href
);

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

test("lint: an object helper's own field is not array misuse", () => {
  assert.deepEqual(
    arrayMethodMisuse("result = helpers.walkChain(id, 'next').length;"),
    [],
  );
  assert.equal(
    arrayMethodMisuse("result = helpers.walkChain(id, 'next').map(f);").length,
    1,
  );
  assert.equal(
    arrayMethodMisuse('result = helpers.pathAll(id).length;').length,
    1,
  );
});

test('lint: a plain {} keyed by heap names is flagged, a literal key is not', () => {
  assert.equal(
    protoKeyTrap(
      'const by = {}; snapshot.nodes.forEach(n => { (by[n.name] ??= []).push(n.id); });',
    ).length,
    1,
  );
  assert.deepEqual(protoKeyTrap("const by = {}; by['a'] = 1; by[0] = 2;"), []);
  assert.deepEqual(
    protoKeyTrap('const by = Object.create(null); by[k] = 1;'),
    [],
  );
  assert.equal(protoKeyTrap('let $c = {}; $c[k] = 1;').length, 1);
  assert.deepEqual(
    protoKeyTrap('const counts = {}; counts.a = 1; m.counts[k] = 2;'),
    [],
  );
  assert.equal(protoKeyTrap('const by = {}; by[`${n.name}`] = 1;').length, 1);
  assert.equal(protoKeyTrap("const by = {}; by['x' + k] = 1;").length, 1);
  assert.deepEqual(protoKeyTrap('const by = {}; by[`x`] = 1;'), []);
  assert.equal(protoKeyTrap('const a = {}, b = {}; b[k] = 1;').length, 1);
  assert.equal(
    protoKeyTrap('const by = {}; for (const n of ns) out.push(...by[n.name]);')
      .length,
    1,
  );
  assert.deepEqual(protoKeyTrap('const by = {}; x = m?.by[k];'), []);
});

test('a query that does not parse gets {error}; the others still answer', () => {
  const out = run([
    {name: 'a', code: 'return 1;'},
    {name: 'b', code: 'return 1 +;'},
    {name: 'c', code: 'result = 3;'},
  ]);
  assert.equal(out.a, 1);
  assert.match(out.b.error, /SyntaxError/);
  assert.equal(out.c, 3);
});

test('duplicate or __proto__ query names are refused', () => {
  const q = name => ({name, code: 'return 1;'});
  assert.throws(() => composeQueries([q('x'), q('x')]), /unique/);
  assert.throws(() => composeQueries([q('__proto__')]), /unique/);
});

test('a max_nodes abort stops the batch and keeps the partial answers', () => {
  const ctx = {
    result: undefined,
    boom() {
      const e = new Error('max_nodes budget of 10 exhausted');
      e.name = 'BudgetExceeded';
      throw e;
    },
  };
  const code = composeQueries([
    {name: 'a', code: 'return 1;'},
    {name: 'b', code: 'result = 5; boom(); result = 6;'},
    {name: 'c', code: 'return 3;'},
  ]);
  assert.throws(() => vm.runInNewContext(code, ctx), /max_nodes/);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.result)), {a: 1, b: 5});
});

test('an abort in the first query with nothing assigned leaves no result', () => {
  const ctx = {
    result: undefined,
    boom() {
      const e = new Error('exhausted');
      e.name = 'BudgetExceeded';
      throw e;
    },
  };
  const code = composeQueries([{name: 'a', code: 'boom(); result = 1;'}]);
  assert.throws(() => vm.runInNewContext(code, ctx));
  assert.equal(ctx.result, undefined);
});

test('a timeout in a later query keeps the answers already made', () => {
  const ctx = {result: undefined};
  const code = composeQueries([
    {name: 'a', code: 'return 1;'},
    {name: 'b', code: 'for (;;) {}'},
  ]);
  assert.throws(() => vm.runInNewContext(code, ctx, {timeout: 200}));
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.result)), {a: 1});
});
