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
 * Unit tests for `memlab_sweep` (tools/sweep.ts): the direct-holder mark of
 * a top-retained row, the residual call built from the leads, section
 * numbering, and the table-row split used by the ladder section.
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
const built = path.join(here, '..', 'dist', 'tools', 'sweep.js');
if (!fs.existsSync(built)) {
  console.error('check-sweep: dist/tools/sweep.js is missing; build first.');
  process.exit(1);
}
const sweep = await import(pathToFileURL(built).href);
const {directHolderMark, residualCall} = sweep;

const node = (id, name, type = 'object') => ({id, name, type});
const noModule = () => undefined;

test('a node dominated by the GC root is marked root', () => {
  assert.equal(directHolderMark(null, noModule), 'root');
  assert.equal(directHolderMark(node(1, '', 'synthetic'), noModule), 'root');
  assert.equal(directHolderMark(node(3, '(GC roots)'), noModule), 'root');
});

test('a global object and a module scope are named', () => {
  assert.equal(
    directHolderMark(node(10, 'Window / https://x.com'), noModule),
    'global',
  );
  assert.equal(
    directHolderMark(node(11, 'system / Context'), id =>
      id === 11 ? 'ConstUriUtils' : undefined,
    ),
    'module ConstUriUtils',
  );
  assert.equal(directHolderMark(node(12, 'Module'), noModule), 'module');
});

test('an ordinary owner is not marked', () => {
  assert.equal(directHolderMark(node(20, 'RelayModernStore'), noModule), '');
});

/** The entries of a residual call, parsed back. */
function entries(call) {
  const body = call.slice(call.indexOf('['), call.lastIndexOf(']') + 1);
  return JSON.parse(body);
}

test('no leads, no call', () => {
  assert.equal(residualCall([], 10), null);
});

test('sections take turns, largest first, top-retained rows last', () => {
  const leads = [
    {label: 'top big', bytes: 9e6, ids: [1], section: 1},
    {label: 'top small', bytes: 1e6, ids: [2], section: 1},
    {label: 'dead array', bytes: 1e5, ids: [3], section: 2},
    {label: 'dead map', bytes: 5e5, ids: [4], section: 2},
    {label: 'strings Object.src', bytes: 2e6, edge: 'Object.src', section: 3},
    {label: 'growth', bytes: 3e5, ids: [5], section: 11},
    {label: 'stale React ref', bytes: 2e5, ids: [6], section: 7},
    {label: 'async queue', bytes: 4e5, ids: [7], section: 10},
    // React lists are not cuts.
    {label: 'React list: Feed', bytes: 9e9, ids: [8], section: 8},
  ];
  const got = entries(residualCall(leads, 10)).map(e => e.label);
  assert.deepEqual(got, [
    'growth',
    'dead map',
    'stale React ref',
    'async queue',
    'strings Object.src',
    'top big',
    'dead array',
    'top small',
  ]);
});

test('an edge lead becomes an edge entry, ids a node_ids entry', () => {
  const call = residualCall(
    [
      {label: 'strings Object.src', bytes: 2, edge: 'Object.src', section: 3},
      {label: 'queue', bytes: 1, ids: [7], section: 10},
    ],
    10,
  );
  assert.deepEqual(entries(call), [
    {label: 'queue', node_ids: [7]},
    {label: 'strings Object.src', edge: 'Object.src'},
  ]);
  assert.match(call, /^memlab_residual\(\{explained: \[/);
});

test('the same node found twice is cut once; equal labels stay apart', () => {
  const call = residualCall(
    [
      {label: 'closure var a', bytes: 3, ids: [1], section: 2},
      {label: 'closure var timerQueue', bytes: 2, ids: [1], section: 4},
      {label: 'closure var a', bytes: 1, ids: [2], section: 2},
    ],
    10,
  );
  assert.deepEqual(entries(call), [
    {label: 'closure var a', node_ids: [1]},
    {label: 'closure var a #2', node_ids: [2]},
  ]);
});

test('the cap bounds the call, and quotes cannot break it', () => {
  const leads = Array.from({length: 30}, (_, i) => ({
    label: `say "x" ${i}`,
    bytes: 100 - i,
    ids: [i + 1],
    section: 2,
  }));
  const got = entries(residualCall(leads, 10));
  assert.equal(got.length, 10);
  assert.equal(got[0].label, "say 'x' 0");
});

test('fields of one record type fold into one row; counts are summed', () => {
  const {foldFields} = sweep;
  const rows = [
    {
      cls: 'FiberNode',
      prop: 'actualDuration',
      count: 54690,
      bytes: 656280,
      sample: 1,
    },
    {
      cls: 'FiberNode',
      prop: 'treeBaseDuration',
      count: 54690,
      bytes: 656280,
      sample: 1,
    },
    {cls: 'Object', prop: 'start', count: 903986, bytes: 1e7, sample: 2},
    {cls: 'Object', prop: 'end', count: 904019, bytes: 1e7, sample: 2},
    {cls: 'FiberNode', prop: 'lanes', count: 47512, bytes: 570144, sample: 3},
  ];
  const got = foldFields(rows).map(r => [r.cls, r.props.join(','), r.count]);
  assert.deepEqual(got, [
    ['Object', 'start,end', 1808005],
    ['FiberNode', 'actualDuration,treeBaseDuration', 109380],
    ['FiberNode', 'lanes', 47512],
  ]);
});

test('numbered: renumbers a section built elsewhere, leaves empty alone', () => {
  const {numbered} = sweep;
  assert.deepEqual(numbered(5, []), []);
  assert.deepEqual(numbered(5, ['## Diagnostic buffers', '', '- a']), [
    '## 5. Diagnostic buffers',
    '',
    '- a',
  ]);
  assert.deepEqual(numbered(7, ['## 9. React state', '']), [
    '## 7. React state',
    '',
  ]);
});

test('cells: padded and compact (terse) table rows split the same way', () => {
  const {cells} = sweep;
  const want = ['Map @12', 'closure var x', 'a.b', '3', '1 KB'];
  assert.deepEqual(cells('| Map @12 | closure var x | a.b | 3 | 1 KB |'), want);
  assert.deepEqual(cells('|Map @12|closure var x|a.b|3|1 KB|'), want);
  // An escaped pipe stays inside its cell.
  assert.deepEqual(cells('|a \\| b|c|'), ['a \\| b', 'c']);
});
