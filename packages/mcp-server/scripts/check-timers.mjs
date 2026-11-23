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
 * Unit tests for `payloadOf` (tools/timers.ts): the biggest object a timer
 * callback captures, through the closures it captures, two levels deep.
 *
 *   npm run build-pkg && npm run test-units
 *
 * Runs against the BUILT dist/.
 */
import assert from 'assert/strict';
import fs from 'fs';
import {test} from 'node:test';
import path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.join(here, '..', 'dist', 'tools', 'timers.js');
if (!fs.existsSync(built)) {
  console.error('check-timers: dist/tools/timers.js is missing; build first.');
  process.exit(1);
}
const {payloadOf} = await import(pathToFileURL(built).href);

let nextIndex = 0;
const obj = (name, retainedSize) => ({
  nodeIndex: nextIndex++,
  type: 'object',
  name,
  retainedSize,
  edge_count: 0,
  references: [],
});
/** A closure whose context captures `vars`. */
const closure = (name, vars = []) => {
  const ctx = {
    references: vars.map(toNode => ({type: 'context', toNode})),
  };
  return {
    nodeIndex: nextIndex++,
    type: 'closure',
    name,
    getReferenceNode: e => (e === 'context' ? ctx : null),
  };
};

test('a closure first met two levels down is still expanded at one', () => {
  const big = obj('Big', 9e6);
  const c = closure('c', [big]);
  const b = closure('b', [c]);
  // fn -> a -> b reaches b at depth 2 before fn -> b reaches it at depth 1.
  const a = closure('a', [b, obj('Small', 10)]);
  const fn = closure('fn', [a, b]);
  assert.equal(payloadOf(fn)?.name, 'Big');
});

test('nothing past two levels of closures counts', () => {
  const far = closure('far', [obj('Far', 9e6)]);
  const fn = closure('fn', [
    closure('one', [closure('two', [far]), obj('Near', 5)]),
  ]);
  assert.equal(payloadOf(fn)?.name, 'Near');
});
