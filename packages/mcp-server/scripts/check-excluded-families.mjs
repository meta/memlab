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
 * Unit tests for registered dev-only / bounded families
 * (excluded-families.ts, known-families.ts): what a family's root retains,
 * per class, so the ladder tools can take it out before computing rates.
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
const dist = path.join(here, '..', 'dist');
if (!fs.existsSync(path.join(dist, 'excluded-families.js'))) {
  console.error(
    'check-excluded-families: dist/excluded-families.js is missing; build first.',
  );
  process.exit(1);
}
const {excludableFamilies, excludedFamilies, excludedSection} = await import(
  pathToFileURL(path.join(dist, 'excluded-families.js')).href
);
const {loadFamilies} = await import(
  pathToFileURL(path.join(dist, 'known-families.js')).href
);
const {familyDeltas} = await import(
  pathToFileURL(path.join(dist, 'tools', 'artifact-budget.js')).href
);

/** A dominator tree: `[id, name, type, self, dominatorId]`. */
function tree(rows) {
  const nodes = rows.map(([id, name, type, self_size], nodeIndex) => ({
    id,
    name,
    type,
    self_size,
    nodeIndex,
    dominatorNode: null,
  }));
  const byId = new Map(nodes.map(n => [n.id, n]));
  rows.forEach(([, , , , dom], i) => {
    nodes[i].dominatorNode = byId.get(dom) ?? nodes[i];
  });
  return {
    byId,
    snapshot: {
      nodes: {length: nodes.length, forEach: cb => nodes.forEach(cb)},
    },
  };
}

const g = tree([
  [3, '(GC roots)', 'synthetic', 0, 3],
  [10, 'Profiler', 'object', 40, 3],
  [11, 'Array', 'object', 32, 10], // Profiler.seen
  [12, 'heap number', 'number', 16, 11],
  [13, 'heap number', 'number', 16, 11],
  [14, 'Array', 'object', 24, 11],
  [15, 'heap number', 'number', 16, 14],
  [20, 'Array', 'object', 32, 3], // app array, not excluded
  [21, 'heap number', 'number', 16, 20],
]);
const key = n => `${n.type}::${n.name}`;
const seen = {
  id: 'seen',
  label: 'Profiler.seen',
  shapes: [],
  kind: 'dev_only',
  locator: 'Profiler.seen',
};

test("a family's retained set, per class", () => {
  const [row] = excludedFamilies(g.snapshot, [seen], key, (_s, k) =>
    k === 'Profiler.seen' ? g.byId.get(11) : null,
  );
  assert.equal(row.root, 11);
  assert.equal(row.nodes, 5);
  assert.equal(row.bytes, 32 + 16 + 16 + 24 + 16);
  assert.deepEqual(row.byClass.get('number::heap number'), {
    count: 3,
    selfSize: 48,
  });
  assert.deepEqual(row.byClass.get('object::Array'), {count: 2, selfSize: 56});
});

test('a nested family is counted under the innermost one only', () => {
  const inner = {...seen, id: 'inner', label: 'inner', locator: 'inner'};
  const [outer, nested] = excludedFamilies(
    g.snapshot,
    [seen, inner],
    key,
    (_s, k) => g.byId.get(k === 'inner' ? 14 : 11),
  );
  assert.equal(outer.nodes, 3);
  assert.equal(nested.nodes, 2);
});

test('an unresolved locator excludes nothing and says so', () => {
  const rows = excludedFamilies(g.snapshot, [seen], key, () => null);
  assert.equal(rows[0].root, null);
  assert.equal(rows[0].nodes, 0);
  const text = excludedSection([rows, rows], ['r0', 'r1']).join('\n');
  assert.match(text, /`Profiler\.seen` did not resolve at r0, r1/);
});

test('only kinds with a locator are excludable; files are validated', () => {
  assert.deepEqual(
    excludableFamilies([
      seen,
      {...seen, kind: undefined},
      {...seen, locator: undefined, shapes: [['a']]},
    ]).map(f => f.id),
    ['seen'],
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'families-'));
  const ok = path.join(dir, 'ok.json');
  fs.writeFileSync(
    ok,
    JSON.stringify({
      families: [
        {id: 'a', label: 'A', kind: 'dev_only', locator: 'M.x'},
        {id: 'b', label: 'B', shapes: [['p', 'q']]},
      ],
    }),
  );
  const fams = loadFamilies(ok);
  assert.deepEqual(fams[0].shapes, []);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(
    bad,
    JSON.stringify({
      families: [{id: 'a', label: 'A', kind: 'leaky', locator: 'M.x'}],
    }),
  );
  assert.throws(() => loadFamilies(bad), /kind must be/);
  fs.writeFileSync(bad, JSON.stringify({families: [{id: 'a', label: 'A'}]}));
  assert.throws(() => loadFamilies(bad), /shapes list .* or a locator/);
  fs.writeFileSync(
    bad,
    JSON.stringify({families: [{id: 'a', label: 'A', locator: 'M.x'}]}),
  );
  assert.throws(() => loadFamilies(bad), /has a locator but no kind/);
});

test('a family found at one end only is not subtracted', () => {
  const fam = label => ({family: {label}});
  const rows = familyDeltas(
    [
      {...fam('both'), root: 1, bytes: 500},
      {...fam('gone'), root: null, bytes: 0},
      {...fam('new'), root: 3, bytes: 700},
      {...fam('never'), root: null, bytes: 0},
    ],
    [
      {root: 1, bytes: 200},
      {root: 2, bytes: 400},
      {root: null, bytes: 0},
      {root: null, bytes: 0},
    ],
    'r5',
    'r0',
  );
  assert.deepEqual(
    rows.map(r => [r.label, r.delta, r.missing]),
    [
      ['both', 300, null],
      ['gone', null, 'not found at r5, not subtracted'],
      ['new', null, 'not found at r0, not subtracted'],
      ['never', null, 'not found'],
    ],
  );
});
