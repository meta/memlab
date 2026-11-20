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
 * Unit tests for the same-id object growth pass behind
 * `memlab_collection_diff({include_objects: true})` (tools/object-growth.ts).
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
const built = path.join(here, '..', 'dist', 'tools', 'object-growth.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-object-growth: dist/tools/object-growth.js is missing; build first.',
  );
  process.exit(1);
}
const {
  classifyGrowth,
  findChain,
  edgeCount,
  ObjectGrowthTracker,
  formatObjectGrowth,
} = await import(pathToFileURL(built).href);

const T = {minEdges: 20, minRetained: 50 * 1024};

/** A fake heap node; `refs` is [edgeName, toNode, type?]. */
function node(id, name, opts = {}) {
  const n = {
    id,
    name,
    type: opts.type ?? 'object',
    edge_count: opts.edges ?? 0,
    retainedSize: opts.retained ?? 0,
    dominatorNode: opts.dom ?? null,
    references: [],
    referrers: [],
    forEachReference(cb) {
      for (const e of this.references) cb(e);
    },
  };
  return n;
}
function link(from, name, to, type = 'property') {
  const e = {name_or_index: name, type, fromNode: from, toNode: to};
  from.references.push(e);
  to.referrers.push(e);
}
function snapshot(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  return {
    nodes: {forEach: cb => nodes.forEach(cb)},
    getNodeById: id => byId.get(id) ?? null,
  };
}

test('classifyGrowth needs growth at every rung, by the threshold', () => {
  assert.deepEqual(classifyGrowth([279, 374, 426], [1, 2, 3], T), {
    byEdges: true,
    byRetained: false,
    chainBar: false,
  });
  // A flat step is a one-off jump, not accumulation.
  assert.equal(classifyGrowth([3, 80, 80], [0, 0, 0], T).byEdges, false);
  assert.equal(
    classifyGrowth([9, 9, 9], [160e3, 523e3, 523e3], T).byRetained,
    false,
  );
  const list = classifyGrowth([11, 11, 11], [1323512, 1340500, 1358048], T);
  assert.equal(list.byRetained, false);
  assert.equal(list.chainBar, true);
});

test('findChain finds a next-like chain on a held child', () => {
  const holder = node(10, 't');
  const a = node(11, 'Msg');
  const b = node(12, 'Msg');
  const c = node(13, 'Msg');
  link(holder, '$5', a);
  link(a, 'prevRoute', b);
  link(a, 'nextRoute', b);
  link(b, 'nextRoute', c);
  const ch = findChain(holder);
  assert.equal(ch.head, a);
  assert.equal(ch.via, '$5');
  assert.equal(ch.next, 'nextRoute');
  // A next-like edge to a different class is not a chain.
  const lone = node(20, 'Foo');
  link(lone, 'next', node(21, 'Bar'));
  assert.equal(findChain(lone), null);
});

test('edgeCount adds the backing store of a Map', () => {
  const m = node(30, 'Map', {edges: 3});
  link(
    m,
    'table',
    node(31, 'system / OrderedHashMap', {edges: 200}),
    'internal',
  );
  link(m, 'map', node(32, 'system / Map', {edges: 5}), 'internal');
  assert.equal(edgeCount(m), 203);
});

/** One rung: a growing buffer, its holder, a flat object, a list holder. */
function rung(i, opts = {}) {
  const holder = node(101, 'Plugin', {edges: 4, retained: 400e3 + i * 200e3});
  const buf = node(103, 'Array', {
    edges: 280 + i * 100,
    retained: 360e3 + i * 200e3,
    dom: holder,
  });
  link(holder, 'mBuff', buf);
  const flat = node(105, 'Flat', {edges: 50, retained: 1e6});
  const bridge = node(107, 't', {edges: 11, retained: 1.3e6 + i * 17e3});
  const items = Array.from({length: 30 + i * 30}, (_, k) =>
    node(1001 + 2 * k, 'Msg', {edges: 3, dom: bridge}),
  );
  link(bridge, '$5', items[0]);
  for (let k = 1; k < items.length; k++) {
    link(items[k - 1], 'nextRoute', items[k]);
  }
  const reused = node(109, opts.renamed ? 'Other' : 'Same', {
    edges: 10 + i * 30,
  });
  return snapshot([holder, buf, flat, bridge, reused, ...items]);
}

test('tracker keeps the growing buffer and list holder, drops the rest', () => {
  const tr = new ObjectGrowthTracker();
  tr.addRung(rung(0));
  tr.addRung(rung(1));
  const last = rung(2);
  tr.addRung(last);
  const {rows, total, mismatchShare} = tr.finish(last, T);
  assert.equal(mismatchShare, 0);
  const ids = rows.map(r => r.id);
  // The holder's growth is the buffer's, so only the buffer is listed.
  assert.ok(ids.includes(103));
  assert.ok(!ids.includes(101));
  assert.ok(!ids.includes(105));
  assert.ok(ids.includes(109));
  const buf = rows.find(r => r.id === 103);
  assert.deepEqual(buf.edges, [280, 380, 480]);
  assert.equal(buf.holder, 'Plugin.mBuff');
  // 34 KB of retained growth: below the bar alone, listed for its chain.
  const bridge = rows.find(r => r.id === 107);
  assert.match(bridge.chain, /^\.\$5 → \.nextRoute ×90$/);
  assert.equal(total, rows.length);
  // Sorted by retained growth.
  assert.equal(rows[0].id, 103);
});

test('an id that names another class is not the same object', () => {
  const tr = new ObjectGrowthTracker();
  tr.addRung(rung(0));
  const last = rung(1, {renamed: true});
  tr.addRung(last);
  const {rows, mismatchShare} = tr.finish(last, T);
  assert.ok(mismatchShare > 0);
  assert.ok(!rows.some(r => r.id === 109));
});

test('formatObjectGrowth prints nothing for nothing, and only a warning across sessions', () => {
  assert.deepEqual(formatObjectGrowth([], 0, T), []);
  const row = {
    id: 103,
    name: 'Array',
    holder: 'Plugin.mBuff',
    edges: [280, 380, 480],
    retained: [360e3, 560e3, 760e3],
    chain: null,
  };
  const out = formatObjectGrowth([row], 1, T).join('\n');
  assert.match(out, /Same-id objects that grew at every rung \(1 of 1\)/);
  assert.match(out, /Plugin\.mBuff\s*\|\s*Array\s*\|\s*280 → 380 → 480\s*\|/);
  assert.match(out, /@103/);
  const warned = formatObjectGrowth([row], 1, T, 0.88).join('\n');
  assert.match(warned, /88\.0% of ids/);
  assert.doesNotMatch(warned, /@103/);
});
