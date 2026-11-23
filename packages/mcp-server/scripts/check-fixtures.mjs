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
 * Fixture checks: drive the BUILT server over stdio against snapshots this
 * script makes itself, and assert invariants every report must keep.
 *
 *   npm run build-pkg && node scripts/check-fixtures.mjs
 *
 * Fixtures: the hand-built scope-tree snapshots in fixtures/ (exact expected
 * answers) and a real Node.js snapshot of this process (shape invariants:
 * shares never exceed 100%, partitions add up, paging is complete and
 * deterministic, structured results carry their snapshot).
 */
/* global globalThis */
import {spawn} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import v8 from 'v8';
import {fileURLToPath, pathToFileURL} from 'url';
import {writeScopeFixtures} from './fixtures/scope-snapshots.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, '..', 'dist', 'index.js');
if (!fs.existsSync(server)) {
  console.error('check-fixtures: dist/index.js is missing; build first.');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memlab-fixtures-'));
const scope = writeScopeFixtures(path.join(tmp, 'scope'));
// Something recognizable to find in the Node.js snapshot.
globalThis.__fixtureRecords = Array.from({length: 500}, (_, i) => ({
  id: i,
  label: `record-${i}`,
}));
// A chain of near-equal retained sizes that collapse mode folds into one
// group, then distinct arrays: the largest-objects candidate list stays
// capped while its groups run out, the case its paging has to get right.
let chainTail = {payload: new Array(200_000).fill(1.5)};
for (let i = 0; i < 100; i++) chainTail = {next: chainTail, i};
globalThis.__fixtureChain = chainTail;
globalThis.__fixtureArrays = Array.from({length: 60}, (_, i) =>
  new Array(20_000 - i * 100).fill(2.5),
);
// A class with an exact, small instance count.
class FixtureWidget {}
globalThis.__fixtureWidgets = [
  new FixtureWidget(),
  new FixtureWidget(),
  new FixtureWidget(),
];
// The widgets again, in a Map one property away from a findable class.
class FixtureWidgetIndex {
  constructor(widgets) {
    this.byName = new Map(widgets.map((w, i) => [`w${i}`, w]));
  }
}
globalThis.__fixtureWidgetIndex = new FixtureWidgetIndex(
  globalThis.__fixtureWidgets,
);
// A class that is reachable but has no instances.
class FixtureUnusedWidget {}
globalThis.__fixtureUnusedWidget = FixtureUnusedWidget;
// Two views of one subtree (a holder and its payload) with more equal-size
// arrays than any fixed look-back window between them in size-then-scan order:
// collapse mode must still fold the payload into its holder.
function makePlateauArray() {
  const a = [];
  for (let i = 0; i < 30_000; i++) a.push(i + 0.5);
  return a;
}
globalThis.__fixturePlateau = Array.from({length: 70}, makePlateauArray);
globalThis.__fixturePlateauHolder = {plateauPayload: makePlateauArray()};
// Enough instances of one class to page past the bounded-heap threshold.
class FixtureMany {
  constructor(n) {
    this.n = n;
  }
}
globalThis.__fixtureMany = Array.from(
  {length: 12_000},
  (_, i) => new FixtureMany(i),
);
// A long class name, to check the session name width against a per-call one.
class FixtureWidthProbeWithAVeryLongClassNameForNameWidthChecks {}
globalThis.__fixtureWidthProbe =
  new FixtureWidthProbeWithAVeryLongClassNameForNameWidthChecks();
// Models keyed by `fid`: a contact and a chat per user share an id (two
// types, not a copy); one message exists twice (a copy).
class FixtureContact {
  constructor(fid) {
    this.fid = fid;
  }
}
class FixtureChat {
  constructor(fid) {
    this.fid = fid;
  }
}
class FixtureMsg {
  constructor(fid) {
    this.fid = fid;
  }
}
globalThis.__fixtureModels = [
  new FixtureContact('fixture-u1'),
  new FixtureChat('fixture-u1'),
  new FixtureContact('fixture-u2'),
  new FixtureChat('fixture-u2'),
  new FixtureMsg('fixture-m1'),
  new FixtureMsg('fixture-m1'),
];
// Fiber-shaped records: a row whose text lost both of its parameters.
class FiberNode {
  constructor(type, props, elementType = type) {
    this.elementType = elementType;
    this.type = type;
    this.memoizedProps = props;
    this.pendingProps = props;
    this.return = null;
    this.child = null;
    this.sibling = null;
    this.stateNode = null;
  }
}
function FixtureChatRow() {}
{
  const owner = new FiberNode(FixtureChatRow, {});
  const span = new FiberNode('span', {});
  span.return = owner;
  const parts = ['You added ', '', ' & ', ''].map(t => new FiberNode(null, t));
  span.child = parts[0];
  parts.forEach((p, i) => {
    p.return = span;
    p.sibling = parts[i + 1] ?? null;
  });
  const ok = new FiberNode('span', {children: 'You added Alice & Bob'});
  ok.return = owner;
  owner.child = span;
  span.sibling = ok;
  globalThis.__fixtureFibers = [owner, span, ok, ...parts];
}
// A promise that never settles, gaining `.then` reactions between snapshots.
function fixturePendingHandler() {}
globalThis.__fixturePending = new Promise(() => {});
for (let i = 0; i < 5; i++) {
  globalThis.__fixturePending.then(fixturePendingHandler);
}
// Retained errors: one template held twice, plus error text in a string.
globalThis.__fixtureErrors = [
  new Error('fixture-error id=1'),
  new Error('fixture-error id=2'),
  JSON.parse(JSON.stringify('TypeError: fixture text failed at step 7')),
];
const nodeSnapshot = v8.writeHeapSnapshot(path.join(tmp, 'node.heapsnapshot'));
// Distinct long strings that exist only in the second snapshot. A flat
// string's class name is its content, so each is a "class" that grew.
// `padEnd` alone makes a concatenated string, which is not named by content.
globalThis.__fixtureLongStrings = Array.from({length: 5}, (_, i) =>
  JSON.parse(JSON.stringify(`fixture-long-string-${i}-`.padEnd(400, 'z'))),
);
for (let i = 0; i < 3; i++) {
  globalThis.__fixturePending.then(fixturePendingHandler);
}
// A message first seen, already copied, after the first rung.
globalThis.__fixtureModels.push(
  new FixtureMsg('fixture-m2'),
  new FixtureMsg('fixture-m2'),
);
globalThis.__fixtureErrors.push(
  new Error('fixture-error id=3'),
  new RangeError('fixture-late 5'),
);
const nodeSnapshotLater = v8.writeHeapSnapshot(
  path.join(tmp, 'node-later.heapsnapshot'),
);

const child = spawn(process.execPath, [server], {
  stdio: ['pipe', 'pipe', 'ignore'],
});
// However the run ends, do not leave the server or the fixtures behind.
process.on('exit', () => {
  child.kill();
  fs.rmSync(tmp, {recursive: true, force: true});
});
let buf = '';
let nextId = 0;
const pending = new Map();
child.stdout.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
// A crashed or wedged server must fail the run, not hang it.
const RPC_TIMEOUT_MS = 5 * 60 * 1000;
let exited = null;
child.on('exit', code => {
  // Keep the first reason: a timeout kills the child, which then exits.
  exited ??= `the server exited (code ${code})`;
  for (const resolve of pending.values()) {
    resolve({error: {message: exited}});
  }
  pending.clear();
});
// Writing to a server that already exited must not throw asynchronously.
child.stdin.on('error', () => {});
const rpc = (method, params) =>
  new Promise(resolve => {
    if (exited != null) {
      resolve({error: {message: exited}});
      return;
    }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      // A server that stopped answering is wedged: fail every later call at
      // once instead of letting each wait out its own timeout.
      exited = `${method} got no reply in ${RPC_TIMEOUT_MS / 1000}s`;
      child.kill();
      resolve({error: {message: exited}});
    }, RPC_TIMEOUT_MS);
    pending.set(id, msg => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(
      JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n',
    );
  });
async function call(name, args = {}) {
  const r = await rpc('tools/call', {name, arguments: args});
  if (r.error) throw new Error(`${name}: ${r.error.message}`);
  const text = (r.result.content ?? []).map(c => c.text).join('\n');
  if (r.result.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
  return {text, data: r.result.structuredContent};
}

const results = [];
async function check(label, fn) {
  try {
    await fn();
    results.push([label, null]);
  } catch (err) {
    results.push([label, err instanceof Error ? err.message : String(err)]);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: {name: 'check-fixtures', version: '0'},
});
if (init.error) {
  console.error(`check-fixtures: ${init.error.message}`);
  process.exit(1);
}
child.stdin.write(
  JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n',
);

// Dead captured variables: exact answers on the scope-tree fixtures.
const deadExpected = {
  base: ['deadVar'],
  block: ['deadVar', 'blockDead'],
  missingVar: ['deadVar'],
  mixed: ['deadVar'],
  nested: ['y'],
  generators: ['done'],
  shared: ['deadVar'],
};
for (const [name, expected] of Object.entries(deadExpected)) {
  await check(`dead_context_variables: ${name}`, async () => {
    const {data} = await call('memlab_dead_context_variables', {
      snapshot: scope[name].file,
    });
    const dead = data.scopes
      .flatMap(s => s.contexts.flatMap(c => c.dead_fields.map(f => f.name)))
      .sort();
    assert(
      JSON.stringify(dead) === JSON.stringify([...expected].sort()),
      `expected ${expected.join(', ')}, got ${dead.join(', ') || 'none'}`,
    );
  });
}
await check(
  'dead_context_variables: a value held elsewhere frees nothing',
  async () => {
    const {data} = await call('memlab_dead_context_variables', {
      snapshot: scope.shared.file,
      include_shared: true,
    });
    const fields = data.scopes.flatMap(s =>
      s.contexts.flatMap(c => c.dead_fields),
    );
    const byName = Object.fromEntries(fields.map(f => [f.name, f]));
    assert(
      byName.sharedDead?.released_size === 0 &&
        byName.sharedDead.retained_size > 9000 &&
        byName.deadVar?.released_size === byName.deadVar.retained_size &&
        byName.deadVar.released_size > 5000,
      `released: ${JSON.stringify(fields)}`,
    );
    const plain = await call('memlab_dead_context_variables', {
      snapshot: scope.shared.file,
    });
    assert(
      /1 dead variable\(s\) whose value something live also reaches/.test(
        plain.text,
      ),
      `note: ${plain.text.slice(0, 400)}`,
    );
  },
);
await check('dead_context_variables: no scope metadata', async () => {
  const {data} = await call('memlab_dead_context_variables', {
    snapshot: scope.noMetadata.file,
  });
  assert(
    data.has_scope_metadata === false,
    'expected has_scope_metadata false',
  );
  assert(
    data.scripts_without_scopes.length === 2,
    'expected 2 unchecked scripts',
  );
});

// Shape invariants on a real snapshot.
// A failed load is a FAIL like any other, and the checks that need the
// snapshot report as skipped rather than crashing the run.
let nodeLoaded = false;
await check('load a Node.js snapshot', async () => {
  await call('memlab_load_snapshot', {file_path: nodeSnapshot});
  nodeLoaded = true;
});
const shapeCheck = (label, fn) =>
  check(label, async () => {
    if (!nodeLoaded)
      throw new Error('skipped: the Node.js snapshot did not load');
    await fn();
  });

await shapeCheck('class_histogram: no row above 100% of the heap', async () => {
  const {text} = await call('memlab_class_histogram', {
    include_retained_size: true,
    limit: 25,
    suppress_suggestions: true,
  });
  const pcts = [...text.matchAll(/\|\s*([\d.]+)%\s*\|/g)].map(m =>
    Number(m[1]),
  );
  assert(pcts.length > 0, 'no % column found');
  assert(
    pcts.every(p => p <= 100),
    `a row reads ${Math.max(...pcts)}%`,
  );
});

await shapeCheck('snapshot_summary: native + V8 heap = total', async () => {
  const {data} = await call('memlab_snapshot_summary');
  const s = data.statistics;
  assert(
    Math.abs(s.native.total + s.v8_heap.total - s.total) <= 1,
    `${s.native.total} + ${s.v8_heap.total} != ${s.total}`,
  );
});

await shapeCheck(
  'native_contexts: owned + shared + unattributed = total',
  async () => {
    const {data} = await call('memlab_native_contexts');
    const owned = data.contexts.reduce((s, c) => s + c.owned_size, 0);
    const sum = owned + data.shared.size + data.unattributed.size;
    assert(sum === data.total_self_size, `${sum} != ${data.total_self_size}`);
  },
);

await shapeCheck(
  'query_objects: pages are complete, disjoint and repeatable',
  async () => {
    const args = {class_name: '^Object$', node_type: 'object', page_size: 40};
    const ids = [];
    let offset = 0;
    let total = null;
    for (let pages = 0; offset != null && pages < 1000; pages++) {
      const {data} = await call('memlab_query_objects', {...args, offset});
      total ??= data.total;
      ids.push(...data.objects.map(o => o.id));
      offset = data.pagination.next_offset;
    }
    assert(ids.length === total, `paged ${ids.length} of ${total}`);
    assert(new Set(ids).size === ids.length, 'a node appeared on two pages');
    const again = await call('memlab_query_objects', {...args, offset: 0});
    assert(
      JSON.stringify(again.data.objects.map(o => o.id)) ===
        JSON.stringify(ids.slice(0, 40)),
      'the first page changed between two calls',
    );
  },
);

await shapeCheck('query_objects: finds the fixture records', async () => {
  const {data} = await call('memlab_query_objects', {
    property_name: '^label$',
    node_type: 'object',
    page_size: 1,
  });
  assert(data.total >= 500, `found ${data.total} objects with a label`);
});

await shapeCheck('structured results carry their snapshot', async () => {
  const calls = [
    ['memlab_largest_objects', {limit: 1}],
    ['memlab_class_histogram', {limit: 1, suppress_suggestions: true}],
    ['memlab_get_node', {node_id: 1}],
  ];
  for (const [name, args] of calls) {
    const {data} = await call(name, args);
    assert(typeof data?.snapshot === 'string', `${name} has no snapshot`);
  }
});

await shapeCheck('retained_by: every kind within the heap', async () => {
  const {data} = await call('memlab_retained_by', {top_classes: 0});
  for (const k of data.kinds) {
    assert(k.self_size <= data.heap_self_size, `${k.kind} exceeds the heap`);
  }
});

await shapeCheck(
  'largest_objects: every advertised next page has rows',
  async () => {
    let offset = 0;
    let pages = 0;
    for (; offset != null && pages < 60; pages++) {
      const {text} = await call('memlab_largest_objects', {limit: 5, offset});
      const rows = (text.match(/^\| @/gm) ?? []).length;
      assert(rows > 0, `the page at offset ${offset} came back empty`);
      const next = text.match(/Next page: `offset: (\d+)`/);
      offset = next != null ? Number(next[1]) : null;
    }
    assert(pages > 1, 'expected more than one page');
  },
);

await shapeCheck(
  'find_nodes_by_class: a short page and a past-end offset give the exact count',
  async () => {
    const args = {class_name: 'FixtureWidget', node_type: 'object'};
    const page = await call('memlab_find_nodes_by_class', {...args, limit: 5});
    assert(
      page.text.includes('Showing 1–3 of 3 instances'),
      `short page footer: ${page.text.slice(-120)}`,
    );
    const past = await call('memlab_find_nodes_by_class', {
      ...args,
      limit: 5,
      offset: 7,
    });
    assert(
      past.text.includes('past the last of 3'),
      `past-end message: ${past.text.slice(0, 120)}`,
    );
  },
);

await shapeCheck(
  'eval iterByClass: instances only, never the class name string',
  async () => {
    const {text} = await call('memlab_eval', {
      code: "result = [helpers.iterByClass('FixtureWidget').map(n => n.type), helpers.iterByClass('FixtureUnusedWidget').length]",
    });
    const [types, unused] = JSON.parse(text.match(/^\[[\s\S]*?^\]$/m)[0]);
    assert(
      types.length === 3 && types.every(t => t === 'object'),
      `FixtureWidget: ${JSON.stringify(types)}`,
    );
    assert(unused === 0, `FixtureUnusedWidget: ${unused}`);
  },
);

await shapeCheck(
  'eval byClass: every id resolves through getNodeById, natives included',
  async () => {
    const {text} = await call('memlab_eval', {
      code: [
        "const natives = helpers.classCounts({type: 'native'}).map(c => c.name);",
        'let victim = null;',
        'snapshot.nodes.forEach(n => {',
        "  if (victim == null && n.type === 'native' && n.name === natives[0]) victim = n.id;",
        '});',
        // The case the class index exists for: an id the snapshot's own id
        // index does not map.
        'const dict = snapshot._nodeId2NodeIdx;',
        'const at = dict.get(victim);',
        'dict.fastStore.delete(victim);',
        'const missingBefore = snapshot.getNodeById(victim) == null;',
        'const ids = helpers.byClass(natives[0], {instancesOnly: false});',
        'const strayResolves = snapshot.getNodeById(victim)?.name === natives[0];',
        'const strayInIter = helpers.iterByClass(natives[0], {instancesOnly: false}).some(n => n.id === victim);',
        'dict.set(victim, at);',
        'let total = 0, resolved = 0;',
        'for (const name of natives) {',
        '  for (const id of helpers.byClass(name, {instancesOnly: false})) {',
        '    total++;',
        '    if (snapshot.getNodeById(id)?.name === name) resolved++;',
        '  }',
        '}',
        'result = {classes: natives.length, total, resolved, missingBefore, listed: ids.includes(victim), strayResolves, strayInIter};',
      ].join('\n'),
    });
    const json = JSON.parse(text.match(/^\{[\s\S]*?^\}$/m)[0]);
    assert(
      json.classes > 0 && json.total > 0,
      `natives: ${text.slice(0, 300)}`,
    );
    assert(
      json.resolved === json.total,
      `resolved ${json.resolved}/${json.total}`,
    );
    assert(
      json.missingBefore &&
        json.listed &&
        json.strayResolves &&
        json.strayInIter,
      `stray id: ${JSON.stringify(json)}`,
    );
    assert(
      text.includes("1 id(s) the snapshot's id index does not map"),
      `footer: ${text.slice(-600)}`,
    );
    // A later eval reads the cached check, and must still get the footer.
    const again = await call('memlab_eval', {
      code: [
        "const natives = helpers.classCounts({type: 'native'}).map(c => c.name);",
        'const n = helpers.byClass(natives[0], {instancesOnly: false}).length;',
        'result = n;',
      ].join('\n'),
    });
    assert(
      again.text.includes("1 id(s) the snapshot's id index does not map"),
      `second eval footer: ${again.text.slice(-600)}`,
    );
  },
);

await shapeCheck(
  'model_duplicates: same id on two model types is not a copy',
  async () => {
    const {text} = await call('memlab_model_duplicates', {
      identity_path: 'fid',
    });
    assert(
      /\*\*1 \(class, identity\) pair\(s\) have copies: 1 extra/.test(text),
      `headline: ${text.slice(0, 400)}`,
    );
    assert(
      /`FixtureMsg` +\| `fixture-m1` +\| +2 \|/.test(text),
      `top copy: ${text.slice(0, 900)}`,
    );
    assert(
      /Same id, different model types.*: 2 identit/.test(text) &&
        /`FixtureChat` \+ `FixtureContact` +\| +2 /.test(text),
      `cross-type: ${text.slice(-700)}`,
    );
    const ladder = await call('memlab_model_duplicates', {
      identity_path: 'fid',
      paths: [nodeSnapshot, nodeSnapshotLater],
    });
    assert(
      /Δ extras vs first/.test(ladder.text) &&
        /`FixtureMsg` +\| `fixture-m1` +\| +2 \| +2 \|/.test(ladder.text),
      `ladder: ${ladder.text.slice(0, 1200)}`,
    );
    assert(
      /`FixtureMsg` +\| `fixture-m2` +\| +0 \| +2 \|/.test(ladder.text),
      `absent at the first rung: ${ladder.text.slice(0, 1200)}`,
    );
  },
);

await shapeCheck(
  'retained_errors: templates with counts at both ends, new ones marked',
  async () => {
    const {text} = await call('memlab_retained_errors', {
      paths: [nodeSnapshot, nodeSnapshotLater],
      limit: 50,
    });
    assert(
      /`Error: fixture-error id=<n>` +\| +2 \| +3 \|/.test(text),
      `grown template: ${text.slice(0, 1500)}`,
    );
    assert(
      /🆕 `RangeError: fixture-late <n>` +\| +0 \| +1 \|/.test(text),
      `new template: ${text.slice(0, 1500)}`,
    );
    assert(
      /`TypeError: fixture text failed at step <n>` +\| +(\d) \| +\1 \|/.test(
        text,
      ),
      `string template: ${text.slice(0, 1500)}`,
    );
  },
);

await shapeCheck(
  'pending_promises: reactions per creator across rungs, and handlers in eval',
  async () => {
    const {text} = await call('memlab_pending_promises', {
      paths: [nodeSnapshot, nodeSnapshotLater],
      group_by: 'creator',
    });
    assert(
      /`?fixturePendingHandler — [^|]*\| +5 \| +8 \| +\+3\.000 \|/.test(text),
      `creator row: ${text.slice(0, 1200)}`,
    );
    const byPromise = await call('memlab_pending_promises', {
      paths: [nodeSnapshot, nodeSnapshotLater],
    });
    assert(
      /First handler/.test(byPromise.text) &&
        /fixturePendingHandler — /.test(byPromise.text),
      `first handler column: ${byPromise.text.slice(0, 1200)}`,
    );
    await call('memlab_load_snapshot', {file_path: nodeSnapshotLater});
    const ev = await call('memlab_eval', {
      code: [
        "const p = helpers.allByEdgeName('__fixturePending')[0].target;",
        'const r = helpers.promiseReactions(p);',
        'result = {count: r.count, state: r.state, fns: r.handlers.map(h => h.fn)};',
      ].join('\n'),
    });
    const json = JSON.parse(ev.text.match(/^\{[\s\S]*?^\}$/m)[0]);
    assert(
      json.count === 8 &&
        json.state === 'pending' &&
        json.fns.includes('fixturePendingHandler'),
      `promiseReactions: ${JSON.stringify(json)}`,
    );
    await call('memlab_load_snapshot', {file_path: nodeSnapshot});
  },
);

await shapeCheck(
  'rendered_text_audit: an empty parameter, by component',
  async () => {
    const {text} = await call('memlab_rendered_text_audit', {});
    assert(
      /empty parameter +\| FixtureChatRow +\| text +\| `You·added··&·` +\| +1 /.test(
        text,
      ),
      `finding: ${text.slice(0, 1200)}`,
    );
    assert(
      !/Alice·&·Bob/.test(text),
      `clean row flagged: ${text.slice(0, 1200)}`,
    );
  },
);

await shapeCheck(
  'eval result: nodes, Maps and Sets come back as JSON, not [object Object]',
  async () => {
    const {text} = await call('memlab_eval', {
      code: "result = {n: 1, widget: helpers.iterByClass('FixtureWidget')[0], m: new Map([['k', 2]]), s: new Set([3])}",
    });
    const json = JSON.parse(text.match(/^\{[\s\S]*?^\}$/m)[0]);
    assert(json.n === 1, `n: ${text.slice(0, 200)}`);
    assert(
      json.widget.name === 'FixtureWidget',
      `widget: ${JSON.stringify(json.widget)}`,
    );
    assert(
      json.m.k === 2 && json.s[0] === 3,
      `m/s: ${JSON.stringify([json.m, json.s])}`,
    );
  },
);

await shapeCheck(
  'eval helpers: newest takes ids, nodes or a predicate and returns ids',
  async () => {
    const {text} = await call('memlab_eval', {
      code: [
        "const ids = helpers.byClass('FixtureWidget', {type: 'object'});",
        'result = {',
        '  fromIds: helpers.newest(ids, 2),',
        "  fromNodes: helpers.newest(helpers.iterByClass('FixtureWidget'), 2),",
        "  fromPred: helpers.newest(n => n.name === 'FixtureWidget' && n.type === 'object', 2),",
        '};',
      ].join('\n'),
    });
    const json = JSON.parse(text.match(/^\{[\s\S]*?^\}$/m)[0]);
    assert(
      Array.isArray(json.fromPred) &&
        json.fromPred.length === 2 &&
        JSON.stringify(json.fromPred) === JSON.stringify(json.fromIds) &&
        JSON.stringify(json.fromNodes) === JSON.stringify(json.fromIds),
      `newest: ${text.slice(0, 300)}`,
    );
    const refusal = await call('memlab_eval', {
      code: "result = helpers.pathAll(helpers.byClass('FixtureWidget'), 'x').map(n => n);",
    }).then(
      r => r.text,
      err => String(err),
    );
    assert(
      /Refused before the scan[\s\S]*`pathAll` returns object \{ids, hops\}/.test(
        refusal,
      ),
      `refusal: ${refusal.slice(0, 300)}`,
    );
    const env = await call('memlab_eval', {
      mode: 'describe_env',
      section: 'return shapes',
    });
    assert(
      /ids\[\]: .*`newest`/.test(env.text),
      `describe_env: ${env.text.slice(0, 300)}`,
    );
  },
);

await shapeCheck(
  'eval helpers: fiberText, countStrings with maxLen, moduleState off a module system',
  async () => {
    const {text} = await call('memlab_eval', {
      code: [
        'result = {',
        "  rows: helpers.fiberText('FixtureChatRow'),",
        '  short: helpers.countStrings(/^You added/, {maxLen: 15}),',
        '  all: helpers.countStrings(/^You added/),',
        '  again: helpers.countStrings(/^You added/),',
        "  mod: helpers.moduleState('NoSuchModule'),",
        '};',
      ].join('\n'),
    });
    const json = JSON.parse(text.match(/^\{[\s\S]*?^\}$/m)[0]);
    assert(
      json.rows.length === 1 &&
        json.rows[0].text === 'You added  & You added Alice & Bob',
      `fiberText: ${JSON.stringify(json.rows)}`,
    );
    assert(
      json.all >= 2 &&
        json.short >= 1 &&
        json.short < json.all &&
        json.again === json.all &&
        json.mod === null,
      `countStrings/moduleState: ${JSON.stringify(json)}`,
    );
  },
);

await shapeCheck(
  'eval helpers: a node works where an id is expected',
  async () => {
    const {text} = await call('memlab_eval', {
      code: [
        "const m = helpers.getProp(helpers.iterByClass('FixtureWidgetIndex')[0], 'byName');",
        'const node = snapshot.getNodeById(m);',
        'result = {',
        '  fromRef: helpers.mapEntryNodes(m).length,',
        '  fromNode: helpers.mapEntryNodes(node).length,',
        '  sameNode: snapshot.getNodeById(node).id === node.id,',
        '  retained: helpers.retainedSize(node) > 0,',
        '  field: node.retainedSize === helpers.retainedSize(node.id) && node.retained_size > 0,',
        "  h: helpers.histogram(helpers.byClass('FixtureWidget'), id => snapshot.getNodeById(id).type),",
        '};',
      ].join('\n'),
    });
    const json = JSON.parse(text.match(/^\{[\s\S]*?^\}$/m)[0]);
    assert(
      json.fromRef === 3 &&
        json.fromNode === 3 &&
        json.sameNode &&
        json.retained &&
        json.field,
      `map: ${text.slice(0, 300)}`,
    );
    assert(
      json.h.length === 1 &&
        json.h[0].key === 'object' &&
        json.h[0].count === 3,
      `histogram: ${JSON.stringify(json.h)}`,
    );
  },
);

await shapeCheck(
  "eval code: JSON.stringify of a node or edge gives a brief, it doesn't throw",
  async () => {
    const {text} = await call('memlab_eval', {
      code: [
        "const w = helpers.iterByClass('FixtureWidget')[0];",
        'result = JSON.parse(JSON.stringify({w, e: [...w.references][0]}));',
      ].join('\n'),
    });
    const json = JSON.parse(text.match(/^\{[\s\S]*?^\}$/m)[0]);
    assert(
      json.w.name === 'FixtureWidget' && typeof json.w.id === 'number',
      `node: ${text.slice(0, 300)}`,
    );
    assert(
      typeof json.e.edge === 'string' && json.e.from.id === json.w.id,
      `edge: ${JSON.stringify(json.e)}`,
    );
  },
);

await shapeCheck(
  'diff_snapshots: a long string class does not widen every row',
  async () => {
    const {text} = await call('memlab_diff_snapshots', {
      before: nodeSnapshot,
      after: nodeSnapshotLater,
      set_active: false,
      limit: 5000,
    });
    assert(
      text.includes('fixture-long-string-0'),
      'the long strings are not in the diff',
    );
    const widest = Math.max(
      ...text
        .split('\n')
        .filter(l => l.startsWith('|'))
        .map(l => l.length),
    );
    assert(widest <= 200, `a table row is ${widest} characters wide`);
    assert(
      text.includes('Full class names of clipped rows'),
      'no footnotes for the clipped names',
    );
  },
);

await shapeCheck(
  'name width: the session width replaces defaults, a per-call width wins',
  async () => {
    const longName =
      'FixtureWidthProbeWithAVeryLongClassNameForNameWidthChecks';
    const args = {class_name: `^${longName}$`, node_type: 'object'};
    await call('memlab_snapshots', {action: 'list', max_name_length: 12});
    try {
      const session = await call('memlab_query_objects', args);
      assert(
        !session.text.includes(longName),
        'the session width did not clip the name',
      );
      const perCall = await call('memlab_query_objects', {
        ...args,
        max_name_length: 60,
      });
      assert(
        perCall.text.includes(longName),
        'a per-call max_name_length did not win over the session width',
      );
    } finally {
      await call('memlab_snapshots', {action: 'list', max_name_length: 0});
    }
  },
);

await shapeCheck(
  'largest_objects: a payload folds into its holder past a long equal-size run',
  async () => {
    const holder = await call('memlab_query_objects', {
      property_name: '^plateauPayload$',
      node_type: 'object',
      page_size: 1,
    });
    const holderId = holder.data.objects[0]?.id;
    assert(holderId != null, 'the plateau holder was not found');
    const refs = await call('memlab_get_references', {
      node_id: holderId,
      edge_filter: 'plateauPayload',
    });
    const payloadId = refs.data.references[0]?.node.id;
    assert(payloadId != null, 'the plateau payload was not found');
    const {text} = await call('memlab_largest_objects', {limit: 300});
    const row = text.split('\n').find(l => l.startsWith(`| @${holderId} `));
    assert(row != null, `holder @${holderId} is not in the top 300`);
    assert(
      /more views? of this subtree/.test(row),
      'the holder folded nothing',
    );
    assert(
      !text.includes(`| @${payloadId} `),
      `payload @${payloadId} has a row of its own`,
    );
  },
);

await shapeCheck(
  'ladder_probe: segment "all" on an A/B round fits each arm in one pass',
  async () => {
    // OFF arm: node, node-later; ON arm: node, node (no growth).
    const run = path.join(tmp, 'ab-round');
    fs.mkdirSync(run, {recursive: true});
    const files = [nodeSnapshot, nodeSnapshotLater, nodeSnapshot, nodeSnapshot];
    const rungs = files.map((f, i) => ({
      index: i,
      path: f,
      cycles: i % 2 === 0 ? 0 : 10,
      isolate_restarted: i === 2,
    }));
    fs.writeFileSync(
      path.join(run, 'run.json'),
      JSON.stringify({
        rungs,
        ladder_splits_after_rung: [1],
        ab: {
          off: {prop: 'p', value: false, rungs: [0, 1]},
          on: {prop: 'p', value: true, rungs: [2, 3]},
        },
      }),
    );
    const {text} = await call('memlab_ladder_probe', {
      run_dir: run,
      segment: 'all',
      metrics: {
        long_strings:
          "result = helpers.stringsWithPrefix('fixture-long-string-').length",
      },
    });
    assert(
      /An A\/B round with `segment: "all"`/.test(text) &&
        /\| long_strings\s*\| 0 → \d+\s*\| \+0\.\d+ [^|]*\| 0 → 0 /.test(
          text,
        ) &&
        /OFF arm: 2 rungs.*ON arm: 2 rungs/.test(text),
      `ladder_probe all: ${text.slice(0, 900)}`,
    );
  },
);

await shapeCheck(
  'find_nodes_by_class: deep pages continue the shallow order exactly',
  async () => {
    const ids = text => (text.match(/IDs: (.*)/)?.[1] ?? '').split(', ');
    for (const order of ['retained_size', 'newest']) {
      const args = {
        class_name: 'FixtureMany',
        node_type: 'object',
        order,
        offset: 9_990,
        output_mode: 'ids',
      };
      // limit 10 stays on the bounded heap; limit 11 crosses to the sort.
      const shallow = await call('memlab_find_nodes_by_class', {
        ...args,
        limit: 10,
      });
      const deep = await call('memlab_find_nodes_by_class', {
        ...args,
        limit: 11,
      });
      assert(
        JSON.stringify(ids(deep.text).slice(0, 10)) ===
          JSON.stringify(ids(shallow.text)),
        `${order}: rows 9,991-10,000 differ between the two paths`,
      );
    }
  },
);

await check(
  'SubtreeCollapser equals the pairwise collapse on random dominator trees',
  async () => {
    const {SubtreeCollapser} = await import(
      pathToFileURL(path.join(here, '..', 'dist', 'utils.js')).href
    );
    const EPS = 0.99;
    const MAX_WALK = 200;
    let seed = 12345;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    // Views of one subtree: chains of small, often zero, self sizes above a
    // big payload, so ancestors are near-equal; ids shuffled so scan order
    // often brings a child before its equal-size ancestor.
    const tree = n => {
      const nodes = [];
      const add = (parent, self) => {
        const node = {self, dominatorNode: parent, kids: []};
        parent?.kids.push(node);
        nodes.push(node);
        return node;
      };
      const root = add(null, 0);
      while (nodes.length < n) {
        let top = nodes[Math.floor(rand() * nodes.length)];
        const depth = 1 + Math.floor(rand() * 25);
        for (let d = 0; d < depth; d++) {
          top = add(top, rand() < 0.5 ? 0 : 8 + Math.floor(rand() * 16));
        }
        add(top, 10_000 + Math.floor(rand() * 90_000));
      }
      const ids = nodes.map((_, i) => i).sort(() => rand() - 0.5);
      nodes.forEach((node, i) => (node.id = ids[i] * 2 + 1));
      const total = node =>
        (node.retainedSize = node.kids.reduce(
          (s, k) => s + total(k),
          node.self,
        ));
      total(root);
      return nodes;
    };
    // The original collapse: scan the rows newest first.
    const dominates = (a, n) => {
      let cur = n.dominatorNode;
      for (let s = 0; cur != null && s < MAX_WALK; s++) {
        if (cur.id === a.id) return true;
        cur = cur.dominatorNode;
      }
      return false;
    };
    const reference = candidates => {
      const rows = [];
      for (const c of candidates) {
        let merged = false;
        for (let i = rows.length - 1; i >= 0; i--) {
          const k = rows[i];
          if (k.node.retainedSize * EPS > c.retainedSize) break;
          const lo = Math.min(c.retainedSize, k.node.retainedSize);
          const hi = Math.max(c.retainedSize, k.node.retainedSize);
          if (
            hi > 0 &&
            lo / hi >= EPS &&
            (dominates(k.node, c) || dominates(c, k.node))
          ) {
            if (dominates(c, k.node)) k.node = c;
            k.mergedCount++;
            merged = true;
            break;
          }
        }
        if (!merged) rows.push({node: c, mergedCount: 0});
      }
      return rows;
    };
    const signature = rows =>
      rows.map(r => `${r.node.id}:${r.mergedCount}`).join(',');
    for (let t = 0; t < 200; t++) {
      const candidates = tree(30 + Math.floor(rand() * 300)).sort(
        (a, b) => b.retainedSize - a.retainedSize || a.id - b.id,
      );
      const collapser = new SubtreeCollapser(EPS, MAX_WALK);
      for (const c of candidates) collapser.push(c);
      assert(
        signature(collapser.rows) === signature(reference(candidates)),
        `tree ${t}: the collapse differs from the pairwise scan`,
      );
    }
  },
);

child.kill();
fs.rmSync(tmp, {recursive: true, force: true});

const failed = results.filter(([, err]) => err != null);
for (const [label, err] of results) {
  console.log(
    `${err == null ? 'PASS' : 'FAIL'}  ${label}${err ? ` — ${err}` : ''}`,
  );
}
console.log(
  `check-fixtures: ${results.length - failed.length} of ${results.length} passed.`,
);
process.exit(failed.length > 0 ? 1 : 0);
