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
 * Unit tests for tools/node-server-pins.ts on a fake Node heap: who holds
 * each extra `vm` realm (Map and key, strong or weak only), and scripts whose
 * closures are all module factories that never ran.
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
const built = path.join(here, '..', 'dist', 'tools', 'node-server-pins.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-node-server-pins: dist/tools/node-server-pins.js is missing; build first.',
  );
  process.exit(1);
}
const {
  mapSlotOf,
  nodeServerPinsSweepSection,
  realmPinLines,
  realmPins,
  unevaluatedLines,
  unevaluatedScripts,
} = await import(pathToFileURL(built).href);

function fakeHeap() {
  const all = [];
  const node = (name, type = 'object', self = 0, retained = self) => {
    const n = {
      id: 1 + 2 * all.length,
      nodeIndex: all.length,
      name,
      type,
      self_size: self,
      retainedSize: retained,
      references: [],
      referrers: [],
      isString: type === 'string',
      forEachReference(cb) {
        for (const e of this.references) cb(e);
      },
    };
    all.push(n);
    return n;
  };
  const edge = (from, name, to, type = 'property') => {
    const e = {name_or_index: name, type, fromNode: from, toNode: to};
    from.references.push(e);
    to.referrers.push(e);
  };
  const snapshot = {
    nodes: {
      get length() {
        return all.length;
      },
      forEach: cb => all.forEach(cb),
      get: i => all[i],
    },
    getNodeById: id => all.find(n => n.id === id),
  };
  return {all, node, edge, snapshot};
}

/** A realm: NativeContext, its meta-map and an object map. */
function realm(h, retained) {
  const nc = h.node('system / NativeContext', 'hidden', 100, retained);
  const meta = h.node('system / Map', 'object shape', 10);
  h.edge(meta, 'native_context', nc, 'internal');
  const map = h.node('system / Map', 'object shape', 10);
  h.edge(map, 'map', meta, 'internal');
  return {nc, map};
}

function obj(h, r, name, self = 20) {
  const o = h.node(name, 'object', self);
  h.edge(o, 'map', r.map, 'internal');
  return o;
}

/** An object created in realm `r`, reaching its NativeContext the V8 way. */
function sandboxObject(h, r) {
  const o = obj(h, r, 'Object');
  const proto = obj(h, r, 'Object');
  const ctor = obj(h, r, 'Object');
  h.edge(o, '__proto__', proto);
  h.edge(proto, 'constructor', ctor);
  h.edge(ctor, 'context', r.nc, 'internal');
  return o;
}

function realmHeap() {
  const h = fakeHeap();
  const root = h.node('(GC roots)', 'synthetic');
  const handles = h.node('(Global handles)', 'synthetic');
  h.edge(root, 1, handles, 'element');
  const main = realm(h, 50_000);
  const global = obj(h, main, 'global');
  h.edge(root, 2, global, 'element');
  h.node('Node / ContextifyContext', 'native', 64);
  // Two route realms, each under its own key of one Map.
  const cache = obj(h, main, 'Map');
  h.edge(global, 'manifestsPerRoute', cache);
  const table = h.node('', 'array', 40);
  h.edge(cache, 'table', table, 'internal');
  const routes = [];
  for (const [i, key] of ['/api/health', '/_not-found'].entries()) {
    const r = realm(h, 140_000 - i);
    h.edge(table, 3 + 2 * i, h.node(key, 'string', 24), 'internal');
    const manifest = sandboxObject(h, r);
    h.edge(table, 4 + 2 * i, manifest, 'internal');
    h.edge(handles, i, r.nc, 'weak');
    routes.push({r, manifest});
  }
  // A third realm with only a weak handle and a held-by-nothing object.
  const weak = realm(h, 30_000);
  sandboxObject(h, weak);
  h.edge(handles, 9, weak.nc, 'weak');
  return {...h, routes, weak, cache, table};
}

test('map slot of a value names its key', () => {
  const {table, routes} = realmHeap();
  const slot = mapSlotOf(table, routes[1].manifest);
  assert.equal(slot.key, '/_not-found');
  assert.equal(mapSlotOf(routes[0].manifest, table), null);
});

test('route realms are strongly held, one per key; the weak one is not', () => {
  const {snapshot, routes, weak, cache} = realmHeap();
  const {pins, groups} = realmPins(snapshot);
  assert.equal(pins.length, 3);
  const byId = new Map(pins.map(p => [p.context.id, p]));
  for (const {r} of routes) {
    const p = byId.get(r.nc.id);
    assert.equal(p.strong, true);
    assert.equal(p.slots.length, 1);
    assert.equal(p.slots[0].map.id, cache.id);
  }
  assert.equal(byId.get(weak.nc.id).strong, false);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].keys, ['/api/health', '/_not-found']);
  const text = realmPinLines(snapshot, 10).join('\n');
  assert.match(text, /\*\*2 realms, one per key of Map @\d+/);
  assert.match(text, /strongly held, \+1 realm per new key\*\*/);
  assert.match(text, /\['\/api\/health'\] → @\d+/);
  assert.match(text, /no: weak handles/);
  const sweep = nodeServerPinsSweepSection(snapshot, 'node').join('\n');
  assert.match(sweep, /2 vm realms, one per key of Map/);
  assert.deepEqual(nodeServerPinsSweepSection(snapshot, 'browser'), []);
});

test('no realm section without a vm ContextifyContext', () => {
  const h = fakeHeap();
  h.node('(GC roots)', 'synthetic');
  realm(h, 10);
  realm(h, 10);
  assert.deepEqual(realmPinLines(h.snapshot, 10), []);
});

/** A chunk of `n` factory closures; `inner` closures ran inside a module. */
function chunk(h, main, holder, name, n, inner, registry) {
  const script = h.node(name, 'code', 100);
  h.edge(
    script,
    'source',
    h.node('module.exports=[…]', 'string', 10_000),
    'internal',
  );
  const exportsArray = h.node('Array', 'object', 16);
  h.edge(holder, name, exportsArray);
  const fnCtx = h.node('system / Context', 'object', 32);
  for (let i = 0; i < n + inner; i++) {
    const sfi = h.node('', 'code', 50);
    h.edge(sfi, 'script', script, 'internal');
    const c = h.node('', 'closure', 32);
    h.edge(c, 'shared', sfi, 'internal');
    if (i < n) {
      h.edge(c, 'context', main.nc, 'internal');
      h.edge(exportsArray, i, c, 'element');
      if (registry != null) h.edge(registry, 10 + i, c, 'internal');
    } else {
      h.edge(c, 'context', fnCtx, 'internal');
      h.edge(exportsArray, i, c, 'element');
    }
  }
  return script;
}

test('chunks with factories only are loaded but never evaluated', () => {
  const h = fakeHeap();
  const root = h.node('(GC roots)', 'synthetic');
  const main = realm(h, 10);
  const cache = h.node('Object', 'object', 10);
  h.edge(root, 1, cache, 'element');
  const factories = h.node('Map', 'object', 10);
  h.edge(root, 2, factories, 'element');
  const table = h.node('', 'array', 10);
  h.edge(factories, 'table', table, 'internal');
  const ssr = chunk(
    h,
    main,
    cache,
    '/app/.next/server/chunks/ssr/db.js',
    12,
    0,
    table,
  );
  const dead = chunk(
    h,
    main,
    cache,
    '/app/.next/server/chunks/db-copy.js',
    12,
    0,
    null,
  );
  chunk(h, main, cache, '/app/.next/server/chunks/live.js', 12, 1, null);
  chunk(h, main, cache, '/app/.next/server/chunks/tiny.js', 3, 0, null);
  const hits = unevaluatedScripts(h.snapshot);
  assert.deepEqual(hits.map(u => u.script.id).sort(), [ssr.id, dead.id].sort());
  const s = hits.find(u => u.script.id === ssr.id);
  assert.equal(s.factories, 12);
  assert.equal(s.inner, 0);
  assert.equal([...s.registered.values()][0], 12);
  // Script + source + 12 closures + 12 SFIs.
  assert.equal(s.freed, 100 + 10_000 + 12 * (32 + 50));
  const text = unevaluatedLines(h.snapshot, 10).join('\n');
  assert.match(text, /Loaded but never evaluated: 2 script/);
  assert.match(text, /0 \(never registered\)/);
  assert.match(text, /12 in Map @\d+/);
  assert.match(
    nodeServerPinsSweepSection(h.snapshot, 'node').join('\n'),
    /2 script\(s\) loaded but never evaluated/,
  );
});
