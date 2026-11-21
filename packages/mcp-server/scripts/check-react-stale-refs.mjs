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
 * Unit tests for `memlab_react_stale_refs` (tools/react-stale-refs.ts):
 * mounted-fiber walk, effect-ring cleanups capturing detached DOM, ScopeInfo
 * function names, and registries of unmounted React values, on a fake graph.
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
const built = path.join(here, '..', 'dist', 'tools', 'react-stale-refs.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-react-stale-refs: dist/tools/react-stale-refs.js is missing; build first.',
  );
  process.exit(1);
}
const {
  mountedFiberIds,
  effectDestroys,
  capturedDetached,
  scopeFunctionName,
  scanReactStaleRefs,
  reactStaleRefsSweepSection,
} = await import(pathToFileURL(built).href);

/** A tiny heap graph: node(name, type, extra) and link(from, to, name, type). */
function graph() {
  const nodes = [];
  let nextId = 11;
  const g = {
    node(name, type = 'object', extra = {}) {
      const n = {
        id: nextId,
        name,
        type,
        is_detached: name.startsWith('Detached '),
        references: [],
        referrers: [],
        dominatorNode: null,
        retainedSize: 0,
        self_size: 0,
        ...extra,
      };
      nextId += 2;
      nodes.push(n);
      return n;
    },
    link(from, to, name, type = 'property') {
      const e = {type, name_or_index: name, fromNode: from, toNode: to};
      from.references.push(e);
      to.referrers.push(e);
      return g;
    },
    snapshot() {
      return {
        nodes: {
          length: nodes.length,
          forEach: cb => nodes.forEach(cb),
        },
        getNodeById: id => nodes.find(n => n.id === id) ?? null,
      };
    },
  };
  return g;
}

function fiber(g, name) {
  const f = g.node('FiberNode');
  const type = g.node(name, 'closure');
  g.link(f, type, 'elementType');
  g.link(f, g.node('Object'), 'memoizedProps');
  g.link(f, g.node('null', 'hidden'), 'return');
  return f;
}

/** Root → HostRoot → FeedUnit (+alternate) → sibling Other; one orphan fiber. */
function feed() {
  const g = graph();
  const root = g.node('FiberRootNode');
  const host = fiber(g, 'HostRoot');
  const unit = fiber(g, 'FeedUnit');
  const unitAlt = fiber(g, 'FeedUnit');
  const other = fiber(g, 'Other');
  const orphan = fiber(g, 'FeedUnit');
  g.link(root, g.node('HTMLDivElement', 'native'), 'containerInfo');
  g.link(root, host, 'current');
  g.link(host, unit, 'child');
  g.link(unit, unitAlt, 'alternate');
  g.link(unit, other, 'sibling');
  // Old effect object (`effect.destroy`) and new one (`effect.inst.destroy`).
  const queue = g.node('Object');
  const e1 = g.node('Object');
  const e2 = g.node('Object');
  const inst = g.node('Object');
  const cleanup = g.node('', 'closure');
  const oldCleanup = g.node('', 'closure');
  g.link(unit, queue, 'updateQueue');
  g.link(queue, e1, 'lastEffect');
  g.link(e1, e2, 'next').link(e2, e1, 'next');
  g.link(e1, inst, 'inst').link(inst, cleanup, 'destroy');
  g.link(e2, oldCleanup, 'destroy');
  // cleanup → Context{el: detached div} → Context{ref} of useSurvey.
  const ctx = g.node('system / Context');
  const parent = g.node('system / Context');
  const el = g.node('Detached HTMLDivElement', 'native', {
    retainedSize: 100000,
  });
  el.dominatorNode = g.node('(GC roots)', 'synthetic');
  g.link(cleanup, ctx, 'context', 'internal');
  g.link(ctx, el, 'el', 'context');
  g.link(ctx, parent, 'previous', 'internal');
  g.link(parent, g.node('Object'), 'ref', 'context');
  // useSurvey's scope sits in the module's scope, which holds its own
  // detached element; the module scope's `previous` is the NativeContext.
  const moduleCtx = g.node('system / Context');
  g.link(parent, moduleCtx, 'previous', 'internal');
  g.link(moduleCtx, g.node('system / NativeContext'), 'previous', 'internal');
  const moduleEl = g.node('Detached HTMLSpanElement', 'native');
  g.link(moduleCtx, moduleEl, 'cachedNode', 'context');
  const info = g.node('system / ScopeInfo');
  g.link(parent, info, 'scope_info', 'internal');
  g.link(info, g.node('ref', 'string'), 0, 'hidden');
  g.link(info, g.node('useSurvey', 'string'), 1, 'hidden');
  const info0 = g.node('system / ScopeInfo');
  g.link(ctx, info0, 'scope_info', 'internal');
  g.link(info0, g.node('el', 'string'), 0, 'hidden');
  g.link(info0, g.node('', 'string'), 1, 'hidden');
  // The old cleanup captures an ATTACHED element: not reported.
  const ctx2 = g.node('system / Context');
  g.link(oldCleanup, ctx2, 'context', 'internal');
  g.link(ctx2, g.node('HTMLDivElement', 'native'), 'node', 'context');
  // Module Map: Unit_0 → scope of the orphan, Unit_1 → scope of `other`.
  const map = g.node('Map');
  const table = g.node('', 'array');
  map.dominatorNode = g.node('system / Context');
  g.link(map, table, 'table', 'internal');
  const k0 = g.node('Unit_0', 'string', {retainedSize: 20});
  const s0 = g.node('Object', 'object', {retainedSize: 70000});
  const k1 = g.node('Unit_1', 'string', {retainedSize: 20});
  const s1 = g.node('Object', 'object', {retainedSize: 300});
  for (const n of [k0, s0, k1, s1]) n.dominatorNode = table;
  g.link(table, k0, 3, 'internal').link(table, s0, 4, 'internal');
  g.link(table, k1, 6, 'internal').link(table, s1, 7, 'internal');
  g.link(s0, orphan, '__reactFiber$abc');
  g.link(s1, other, '__reactFiber$abc');
  return {
    g,
    root,
    host,
    unit,
    unitAlt,
    other,
    orphan,
    cleanup,
    ctx,
    parent,
    el,
    map,
    s0,
  };
}

test('mounted = current tree via child/sibling plus alternates', () => {
  const f = feed();
  const {mounted, current} = mountedFiberIds([f.root]);
  assert.equal(current, 3);
  for (const n of [f.host, f.unit, f.unitAlt, f.other]) {
    assert.ok(mounted.has(n.id));
  }
  assert.ok(!mounted.has(f.orphan.id));
});

test('effect ring yields inst.destroy and legacy destroy, once each', () => {
  const f = feed();
  const d = effectDestroys(f.unit);
  assert.equal(d.length, 2);
  assert.equal(d[0].destroy.id, f.cleanup.id);
});

test('only detached DOM in the scope chain is captured', () => {
  const f = feed();
  const hits = effectDestroys(f.unit).flatMap(x => capturedDetached(x.destroy));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].variable, 'el');
  assert.equal(hits[0].target.id, f.el.id);
});

test('the climb stops at module scope', () => {
  const f = feed();
  // A cleanup created in the hook body that captures nothing of its own:
  // its context is useSurvey's scope, whose `previous` is the module's.
  const bare = f.g.node('', 'closure');
  f.g.link(bare, f.parent, 'context', 'internal');
  assert.deepEqual(capturedDetached(bare), []);
  assert.deepEqual(capturedDetached(bare, 5), []);
  const deep = capturedDetached(f.cleanup, 5);
  assert.deepEqual(
    deep.map(h => h.variable),
    ['el'],
  );
});

test('ScopeInfo names the hook, an anonymous scope gives null', () => {
  const f = feed();
  assert.equal(scopeFunctionName(f.parent), 'useSurvey');
  assert.equal(scopeFunctionName(f.ctx), null);
});

test('scan groups the cleanup and the stale registry entries', () => {
  const f = feed();
  const scan = scanReactStaleRefs(f.g.snapshot());
  assert.equal(scan.cleanups.length, 1);
  const c = scan.cleanups[0];
  assert.equal(c.component, 'FeedUnit');
  assert.equal(c.variable, 'el');
  assert.equal(c.retained, 100000);
  assert.equal(c.soleFreed, 0);
  assert.match(c.chain, /useSurvey \{ref\}/);
  assert.equal(scan.entries.length, 1);
  const e = scan.entries[0];
  assert.equal(e.collection.id, f.map.id);
  assert.equal(e.total, 2);
  assert.equal(e.staleValues.length, 1);
  assert.equal(e.staleValues[0].id, f.s0.id);
  assert.equal(e.freed, 70020);
  assert.deepEqual(e.sampleKeys, ['"Unit_0"']);
});

test('a registry owned by unmounted state is skipped', () => {
  const f = feed();
  f.map.dominatorNode = f.orphan;
  const scan = scanReactStaleRefs(f.g.snapshot());
  assert.equal(scan.entries.length, 0);
  assert.equal(scan.deadHolders, 1);
});

test('no fiber root: nothing reported, empty sweep section', () => {
  const g = graph();
  const orphan = fiber(g, 'Lonely');
  const scope = g.node('Object');
  g.link(scope, orphan, '__reactFiber$x');
  const snap = g.snapshot();
  const scan = scanReactStaleRefs(snap);
  assert.equal(scan.cleanups.length + scan.entries.length, 0);
  assert.deepEqual(reactStaleRefsSweepSection(snap), []);
});

test('sweep section drops tiny leads', () => {
  const f = feed();
  f.el.retainedSize = 104;
  f.s0.retainedSize = 300;
  assert.deepEqual(reactStaleRefsSweepSection(f.g.snapshot()), []);
});

test('sweep section lines and leads', () => {
  const f = feed();
  const leads = [];
  const lines = reactStaleRefsSweepSection(f.g.snapshot(), {section: 9, leads});
  assert.match(lines[0], /^## 9\. React state holding dead UI/);
  assert.ok(lines.some(l => /effect cleanups on mounted `FeedUnit`/.test(l)));
  assert.ok(lines.some(l => /1 of 2 entries/.test(l)));
  assert.equal(leads.length, 2);
  assert.deepEqual(leads[1].ids, [f.s0.id]);
});
