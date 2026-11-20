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
 * Unit tests for `collectFunctions` / `diffCode` (tools/code-diff.ts): the
 * per-function code A/B behind memlab_code_diff.
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
const built = path.join(here, '..', 'dist', 'tools', 'code-diff.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-code-diff: dist/tools/code-diff.js is missing; build first.',
  );
  process.exit(1);
}
const {collectFunctions, diffCode, isComponentName, renderCodeDiff} =
  await import(pathToFileURL(built).href);

let nextIndex = 0;
function node(name, self_size, refs = {}, type = 'code') {
  const n = {
    name,
    self_size,
    type,
    nodeIndex: nextIndex,
    id: 2 * nextIndex + 1,
  };
  nextIndex++;
  n.references = Object.entries(refs).map(([k, t]) => ({
    name_or_index: k,
    toNode: t,
  }));
  return n;
}
const snapshot = nodes => ({nodes: {forEach: fn => nodes.forEach(fn)}});
const script = node('https://x.test/a.js?v=1', 72);
const map = node('system / Map', 40, {}, 'hidden');

/** An SFI whose function_data is a BytecodeArray of `size` + a constant pool. */
function compiled(name, size, viaCode = false) {
  const bca = node('system / BytecodeArray', size, {
    map,
    0: node('(constant pool)', 16),
  });
  const fm = node('system / FeedbackMetadata', 20);
  const fd = viaCode
    ? node('(BASELINE code)', 56, {
        interpreter_data: bca,
        instruction_stream: node('(BASELINE instruction stream)', 300, {
          relocation_info: node('(code relocation info)', 24),
          0: bca,
        }),
        map,
      })
    : bca;
  return node(name, 44, {
    function_data: fd,
    script,
    raw_outer_scope_info_or_feedback_metadata: fm,
  });
}
function uncompiled(name) {
  const unc = node('system / UncompiledDataWithPreparseData', 20, {
    1: node('system / PreparseData', 28),
  });
  return node(name, 44, {function_data: unc, script});
}

test('collects bytecode, machine code, feedback and uncompiled bytes', () => {
  const recs = collectFunctions(
    snapshot([
      compiled('Foo', 100, true),
      uncompiled('bar'),
      node('noScript', 44),
    ]),
  );
  assert.equal(recs.length, 2);
  const [foo, bar] = recs;
  assert.equal(foo.state, 'compiled');
  assert.equal(foo.script, 'https://x.test/a.js');
  assert.deepEqual(foo.bytes, {
    bytecode: 116,
    jit: 380,
    feedback: 20,
    uncompiled: 0,
  });
  assert.equal(foo.array, 100);
  assert.equal(bar.state, 'uncompiled');
  assert.equal(bar.bytes.uncompiled, 48);
});

test('old V8: script_or_debug_info and a code container', () => {
  const bca = node('system / BytecodeArray', 60, {map});
  const code = node('(code for f)', 768, {interpreter_data: bca, map});
  const sfi = node('f', 36, {
    function_data: node('', 24, {map, 0: code}),
    script_or_debug_info: script,
  });
  const [r] = collectFunctions(snapshot([sfi]));
  assert.equal(r.state, 'compiled');
  assert.equal(r.bytes.bytecode, 60);
  assert.equal(r.bytes.jit, 24 + 768);
});

test('components', () => {
  assert.ok(isComponentName('PolarisProfilePageContent'));
  assert.ok(isComponentName('IGDSHoverCard_DEPRECATED'));
  assert.ok(!isComponentName('TROMPLE_MAIN'));
  assert.ok(!isComponentName('useFoo'));
});

test('splits same-function growth, flips and unmatched', () => {
  const a = collectFunctions(
    snapshot([
      compiled('Box', 100),
      compiled('helper', 50),
      compiled('gone', 40),
      uncompiled('lazy'),
      compiled('(shared function info)', 30),
      compiled('dup', 10),
      compiled('dup', 10),
    ]),
  );
  const b = collectFunctions(
    snapshot([
      compiled('Box', 300),
      compiled('helper', 50),
      uncompiled('gone'),
      compiled('lazy', 80),
      compiled('(shared function info)', 30),
      compiled('(shared function info)', 30),
      compiled('dup', 10),
      compiled('dup', 10),
    ]),
  );
  const d = diffCode(a, b);
  assert.equal(d.matched, 4);
  assert.equal(d.groups.components.count, 1);
  assert.equal(d.groups.components.changed, 1);
  assert.equal(d.groups.components.arrayDelta, 200);
  assert.equal(d.groups.components.median, 316 / 116);
  assert.equal(d.groups.others.changed, 0);
  assert.equal(d.groups.others.median, null);
  assert.equal(d.same.bytecode, 200);
  assert.equal(d.flips.aOnly, 1);
  assert.equal(d.flips.bOnly, 1);
  assert.equal(d.flips.aOnlyBytes, 48 - (56 + 20));
  assert.equal(d.flips.bOnlyBytes, 96 + 20 - 48);
  assert.deepEqual(d.unmatched.count, [3, 4]);
  assert.equal(d.unmatched.delta, 46 + 20);
  assert.equal(d.top.length, 1);
  assert.equal(d.top[0].a.name, 'Box');
  // The three buckets add up to the net.
  const net = k => k.bytecode + k.jit + k.feedback + k.uncompiled;
  assert.equal(
    net(d.same) + d.flips.aOnlyBytes + d.flips.bOnlyBytes + d.unmatched.delta,
    net(d.totals[1]) - net(d.totals[0]),
  );
  assert.deepEqual(d.sfis, [7, 8, 6, 7]);
  const text = renderCodeDiff(d, ['a', 'b']);
  assert.match(text, /same-function bytecode \+200 B/);
  assert.match(text, /compile-state flips/);
  assert.match(text, /Box/);
});
