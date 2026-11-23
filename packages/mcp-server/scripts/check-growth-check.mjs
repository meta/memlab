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
 * Unit tests for `growthVerdict` (tools/growth-check.ts).
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
const built = path.join(here, '..', 'dist', 'tools', 'growth-check.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-growth-check: dist/tools/growth-check.js is missing; build first.',
  );
  process.exit(1);
}
const {growthVerdict, membersBase} = await import(pathToFileURL(built).href);
const {isolateOf, isolateSample} = await import(
  pathToFileURL(path.join(here, '..', 'dist', 'isolate-identity.js')).href
);

const ids = (from, n) => new Set(Array.from({length: n}, (_, i) => from + i));
const rung = (label, entries, retained, members, found = 'id') => ({
  label,
  found,
  entries,
  retained,
  members,
});

test('grows: more entries, old members kept', () => {
  const v = growthVerdict([
    rung('a', 100, 1000, ids(0, 100)),
    rung('b', 300, 3000, ids(0, 300)),
  ]);
  assert.equal(v.verdict, 'grows');
  assert.match(v.why, /rising at every rung/);
});

test('frozen: same members and size on every rung', () => {
  const v = growthVerdict([
    rung('a', 50, 5000, ids(0, 50)),
    rung('b', 50, 5000, ids(0, 50)),
    rung('c', 50, 5010, ids(0, 50)),
  ]);
  assert.equal(v.verdict, 'frozen');
});

test('turns over: same size, members replaced', () => {
  const v = growthVerdict([
    rung('a', 200, 9000, ids(0, 200)),
    rung('b', 205, 9100, ids(1000, 205)),
  ]);
  assert.equal(v.verdict, 'turns over');
});

test('shrinks', () => {
  assert.equal(
    growthVerdict([rung('a', 93, 1, ids(0, 93)), rung('b', 18, 1, ids(0, 18))])
      .verdict,
    'shrinks',
  );
});

test('one rung, or a holder only on the last rung, is not comparable', () => {
  assert.equal(
    growthVerdict([rung('a', 10, 1, ids(0, 10))]).verdict,
    'not comparable',
  );
  const v = growthVerdict([
    rung('a', null, 0, new Set(), null),
    rung('b', 10, 1, ids(0, 10)),
  ]);
  assert.equal(v.verdict, 'not comparable');
  assert.match(v.why, /created since/);
});

test('an object without entries is sized by retained bytes', () => {
  const v = growthVerdict([
    rung('a', null, 1000, ids(0, 5)),
    rung('b', null, 5000, ids(0, 9)),
  ]);
  assert.equal(v.verdict, 'grows');
  assert.match(v.why, /retained bytes/);
});

test('frozen needs every rung unchanged, not only the ends', () => {
  const v = growthVerdict([
    rung('a', 50, 5000, ids(0, 50)),
    rung('b', 400, 40000, ids(0, 400)),
    rung('c', 50, 5000, ids(0, 50)),
  ]);
  assert.equal(v.verdict, 'flat');
  assert.match(v.why, /400 on b between them/);
});

test('no members to compare is never frozen', () => {
  const v = growthVerdict([
    rung('a', 20, 2000, new Set()),
    rung('b', 20, 2000, new Set()),
  ]);
  assert.notEqual(v.verdict, 'frozen');
});

test('a rung without an entry count sizes every rung by bytes', () => {
  const v = growthVerdict([
    rung('a', null, 12000, ids(0, 5), 'path'),
    rung('b', 40, 30000, ids(0, 40)),
  ]);
  assert.equal(v.verdict, 'grows');
  assert.match(v.why, /retained bytes 12,000 \u2192 30,000/);
});

test('an anonymous holder on another session is not "created since"', () => {
  const v = growthVerdict(
    [
      {...rung('a', null, 0, new Set(), null), isolate: 'other'},
      {...rung('b', 10, 1, ids(0, 10)), isolate: 'same'},
    ],
    false,
  );
  assert.equal(v.verdict, 'not comparable');
  assert.doesNotMatch(v.why, /created since/);
  assert.match(v.why, /another session/);
});

test('members of a rung from another session are not compared', () => {
  const v = growthVerdict([
    {...rung('a', 50, 5000, ids(0, 50), 'path'), isolate: 'other'},
    {...rung('b', 50, 5000, ids(1000, 50)), isolate: 'same'},
  ]);
  assert.equal(v.verdict, 'flat');
  assert.match(v.why, /members not compared/);
});

test('a lone same-session rung is no membership base for the table', () => {
  const rungs = [
    {...rung('a', 50, 5000, ids(0, 50), 'path'), isolate: 'other'},
    {...rung('b', 50, 5000, ids(1000, 50)), isolate: 'same'},
  ];
  assert.equal(membersBase(rungs), null);
  rungs.push({...rung('c', 50, 5000, ids(1000, 50)), isolate: 'same'});
  assert.equal(membersBase(rungs)?.label, 'b');
});

test('membership is measured from the first same-session rung', () => {
  const v = growthVerdict([
    {...rung('a', 50, 5000, ids(0, 50), 'path'), isolate: 'other'},
    {...rung('b', 50, 5000, ids(1000, 50)), isolate: 'same'},
    {...rung('c', 50, 5000, ids(2000, 50)), isolate: 'same'},
  ]);
  assert.equal(v.verdict, 'turns over');
  assert.match(v.why, /0% of b's members/);
  const same = growthVerdict([
    {...rung('a', 50, 5000, ids(0, 50), 'path'), isolate: 'other'},
    {...rung('b', 50, 5000, ids(1000, 50)), isolate: 'same'},
    {...rung('c', 50, 5000, ids(1000, 50)), isolate: 'same'},
  ]);
  assert.notEqual(same.verdict, 'frozen');
});

test('isolateOf tells a same-isolate rung from a reused id range', () => {
  const snap = nodes => {
    const byId = new Map(nodes.map(n => [n.id, n]));
    return {
      nodes: {length: nodes.length, get: i => nodes[i] ?? null},
      getNodeById: id => byId.get(id) ?? null,
    };
  };
  const make = (prefix, n) =>
    Array.from({length: n}, (_, i) => ({
      id: 10 + i * 2,
      type: 'object',
      name: `${prefix}${i % 7}`,
    }));
  const sample = isolateSample(snap(make('A', 500)));
  assert.equal(isolateOf(snap(make('A', 500)), sample), 'same');
  assert.equal(isolateOf(snap(make('B', 500)), sample), 'other');
  assert.equal(isolateOf(snap(make('A', 50)), sample), 'unknown');
});
