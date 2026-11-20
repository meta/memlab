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
 * Unit tests for string families (string-families.ts): the normalised-prefix
 * key, the one-pass census with its threshold and byte accounting, and the
 * holder labels, on fake nodes.
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
const built = path.join(here, '..', 'dist', 'string-families.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-string-families: dist/string-families.js is missing; build first.',
  );
  process.exit(1);
}
const {
  stringFamilyKey,
  stringFamilyCensus,
  formatStringFamilies,
  stringHolderLabel,
} = await import(pathToFileURL(built).href);

/** A tiny graph: `node(…)` makes nodes, `edge(from, to, type, name)` links. */
function graph() {
  const nodes = [];
  const node = (type, name, self_size = 16) => {
    const n = {
      id: nodes.length * 2 + 11,
      nodeIndex: nodes.length,
      type,
      name,
      self_size,
      references: [],
      referrers: [],
      dominatorNode: null,
      get isString() {
        return /string/.test(this.type);
      },
    };
    nodes.push(n);
    return n;
  };
  const edge = (from, to, type, name_or_index) => {
    const e = {fromNode: from, toNode: to, type, name_or_index};
    from.references.push(e);
    to.referrers.push(e);
    return e;
  };
  const snapshot = {
    nodes: {
      forEach: cb => nodes.forEach(cb),
      get: i => nodes[i] ?? null,
    },
  };
  return {node, edge, snapshot};
}

test('digits are masked per run, data: URLs keyed by mime', () => {
  assert.equal(
    stringFamilyKey('{"query_id":-2901123410823651408,"serialized":"z5_'),
    '{"query_id":-#,"serializ',
  );
  // Different digit counts land in the same family.
  assert.equal(
    stringFamilyKey('client: 491:attachment:ghl_x'),
    stringFamilyKey('client: 7:attachment:ghl_y'),
  );
  assert.equal(
    stringFamilyKey('data:application/x-javascript; charset=utf-8;base64,AAAA'),
    'data:application/x-javascript; charset=utf-8;base64,',
  );
  assert.equal(
    stringFamilyKey('data:image/png;base64,iVBOR'),
    'data:image/png;base64,',
  );
  assert.notEqual(
    stringFamilyKey('data:image/png;base64,x'),
    stringFamilyKey('data:image/gif;base64,x'),
  );
  assert.equal(stringFamilyKey('short'), 'short');
});

test('census: threshold, flat self bytes only, script source excluded', () => {
  const {node, edge, snapshot} = graph();
  const store = node('object', 'RelayRecordSource', 100);
  const record = node('object', 'Object', 50);
  edge(store, record, 'property', 'r1');
  record.dominatorNode = store;
  const blobs = [];
  for (let i = 0; i < 4; i++) {
    const s = node(
      'string',
      `{"query_id":${1000 + i},"serialized":"z5_…`,
      30_000,
    );
    edge(record, s, 'property', 'debug_info');
    s.dominatorNode = record;
    blobs.push(s);
  }
  // A cons wrapper over one blob: its self size must not be added, and the
  // blob's holder is found through it.
  const cons = node('concatenated string', '(concatenated string)', 32);
  edge(cons, blobs[0], 'internal', 'first');
  // Script source text, large, must not form a family.
  const script = node('code', 'system / Script / app.js', 80);
  const src = node('string', '"use strict"; var a = 1; …', 500_000);
  edge(script, src, 'internal', 'source');
  node('string', 'tiny', 10);

  const census = stringFamilyCensus(snapshot, {minBytes: 100_000});
  assert.equal(census.families.length, 1);
  const f = census.families[0];
  assert.equal(f.key, '{"query_id":#,"serialize');
  assert.equal(f.count, 4);
  assert.equal(f.bytes, 120_000);
  assert.equal(census.sourceCount, 1);
  assert.equal(census.sourceBytes, 500_000);
  assert.match(f.examplePreview, /^\{"query_id":/);
  // 3 held directly; the 4th through its cons wrapper, which has no holder.
  assert.equal(f.holders[0].label, 'RelayRecordSource.r1 › Object.debug_info');
  assert.equal(f.holders[0].count, 3);

  // The heap share lowers the bar on a small heap: 0.5% of ~1.1 MB.
  const shared = stringFamilyCensus(snapshot);
  assert.equal(shared.threshold, Math.ceil(shared.totalBytes * 0.005));
  assert.equal(shared.families.length, 1);

  // Light load: no holders, and the table says so.
  const light = stringFamilyCensus(snapshot, {
    minBytes: 100_000,
    holders: false,
  });
  assert.equal(light.families[0].sampled, 0);
  assert.match(formatStringFamilies(light).join('\n'), /n\/a \(light load\)/);
});

test('nothing qualifies: no lines at all', () => {
  const {node, snapshot} = graph();
  node('string', 'a', 10);
  node('string', 'b', 10);
  const census = stringFamilyCensus(snapshot, {
    minBytes: 1024 * 1024,
    minHeapShare: 0,
  });
  assert.equal(census.families.length, 0);
  assert.deepEqual(formatStringFamilies(census), []);
});

test('row cap and "more families" footnote', () => {
  const {node, snapshot} = graph();
  for (let i = 0; i < 12; i++)
    node('string', `family${'abcdefghijkl'[i]}-x`, 2000);
  const census = stringFamilyCensus(snapshot, {
    minBytes: 1000,
    minHeapShare: 0,
    limit: 8,
  });
  assert.equal(census.families.length, 8);
  assert.equal(census.qualifying, 12);
  const text = formatStringFamilies(census).join('\n');
  assert.match(text, /4 more families qualify/);
  assert.equal(text.split('\n').filter(l => /^\| *`family/.test(l)).length, 8);
});

test('holder of an element: the largest container, named by its owner', () => {
  const {node, edge} = graph();
  const ctx = node('object', 'system / Context', 40);
  const map = node('object', 'Map', 32);
  const table = node('array', '', 90_000);
  const small = node('array', '', 200);
  edge(ctx, map, 'context', '_resources');
  map.dominatorNode = ctx;
  edge(map, table, 'internal', 'table');
  const desc = node('object', 'Object', 40);
  edge(small, desc, 'internal', 3);
  edge(table, desc, 'internal', 7);
  const s = node('string', 'data:application/x-javascript;base64,AA', 20_000);
  edge(desc, s, 'property', 'src');
  assert.equal(stringHolderLabel(s), 'closure var _resources[] › Object.src');
  // A string held only as an element names the array's holder.
  const arr = node('object', 'Array', 16);
  const owner = node('object', 'Hook', 16);
  edge(owner, arr, 'property', 'deps');
  arr.dominatorNode = owner;
  const t = node('string', 'cacheKey', 100);
  edge(arr, t, 'element', 1);
  assert.equal(stringHolderLabel(t), 'Hook.deps[]');
});
