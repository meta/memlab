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
 * Unit tests for `duplicateGroups` (tools/duplicate-subscriptions.ts).
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
const built = path.join(
  here,
  '..',
  'dist',
  'tools',
  'duplicate-subscriptions.js',
);
if (!fs.existsSync(built)) {
  console.error(
    'check-duplicate-subscriptions: dist/tools/duplicate-subscriptions.js is missing; build first.',
  );
  process.exit(1);
}
const {collectRegistrations, duplicateGroups, registerDuplicateSubscriptions} =
  await import(pathToFileURL(built).href);
const {setSnapshot, clearAllSnapshots} = await import(
  pathToFileURL(path.join(here, '..', 'dist', 'heap-state.js')).href
);

let closure = 1000;
const reg = (o = {}) => ({
  kind: 'emitter',
  storeId: 1,
  store: 'Collection._events',
  event: 'change',
  subscriber: 0,
  code: 'sfi:7',
  codeStable: 'onChange',
  codeLabel: 'onChange',
  closureId: closure++,
  ...o,
});

test('one subscriber re-registering fresh closures of one function is a duplicate', () => {
  const regs = [
    ...Array.from({length: 5}, () => reg({subscriber: 42})),
    reg({subscriber: 43}),
  ];
  const {duplicates, perCode} = duplicateGroups(regs);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].subscriber, 42);
  assert.equal(duplicates[0].registrations, 5);
  assert.equal(duplicates[0].closures, 5);
  assert.equal(perCode[0].registrations, 6);
  assert.equal(perCode[0].subscribers, 2);
});

test('the same closure added twice is a duplicate even without a subscriber', () => {
  const {duplicates} = duplicateGroups([
    reg({closureId: 7}),
    reg({closureId: 7}),
  ]);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].closures, 1);
});

test('fresh closures with no subscriber are one per instance, not duplicates', () => {
  const {duplicates, perCode} = duplicateGroups(
    Array.from({length: 30}, () => reg()),
  );
  assert.equal(duplicates.length, 0);
  assert.equal(perCode[0].registrations, 30);
  assert.equal(perCode[0].subscribers, 0);
});

test('different events or code do not merge', () => {
  const {duplicates} = duplicateGroups([
    reg({subscriber: 9}),
    reg({subscriber: 9, event: 'add'}),
    reg({subscriber: 9, code: 'sfi:8'}),
  ]);
  assert.equal(duplicates.length, 0);
});

test('DOM callbacks shared across unknown event types are counted, not duplicates', () => {
  const {duplicates, perCode} = duplicateGroups([
    reg({kind: 'dom', event: '', closureId: 7}),
    reg({kind: 'dom', event: '', closureId: 7}),
  ]);
  assert.equal(duplicates.length, 0);
  assert.equal(perCode[0].registrations, 2);
  assert.equal(perCode[0].subscribers, 0);
});

test('the no-subscriber sentinel does not increase a mixed group subscriber count', () => {
  const {perCode} = duplicateGroups([
    reg(),
    reg({subscriber: 42}),
    reg({subscriber: 42}),
    reg({subscriber: 43}),
  ]);
  assert.equal(perCode[0].registrations, 4);
  assert.equal(perCode[0].subscribers, 2);
});

function graph() {
  const nodes = [];
  const node = (name, type = 'object') => {
    const n = {
      id: 10 + nodes.length,
      name,
      type,
      self_size: 24,
      location: null,
      references: [],
      referrers: [],
    };
    nodes.push(n);
    return n;
  };
  const edge = (from, name, to, type = 'property') => {
    const e = {type, name_or_index: name, fromNode: from, toNode: to};
    from.references.push(e);
    to.referrers.push(e);
  };
  const sfi = node('onChange code', 'code');
  const callback = () => {
    const fn = node('onChange', 'closure');
    edge(fn, 'shared', sfi, 'internal');
    return fn;
  };
  const bind = (fn, receiver) => {
    const bound = node('native_bind', 'closure');
    edge(bound, 'bound_function', fn, 'internal');
    edge(bound, 'bound_this', receiver, 'internal');
    return bound;
  };
  const registry = callbacks => {
    const host = node('Collection');
    const events = node('Object');
    edge(host, '_events', events);
    for (const [event, listeners] of [
      ['change', callbacks],
      ['other', [callback()]],
    ]) {
      const array = node('Array');
      edge(events, event, array);
      listeners.forEach((fn, i) => edge(array, i, fn, 'element'));
    }
    return events;
  };
  const listenerSet = listeners => {
    const host = node('Subject');
    const set = node('Set');
    const table = node('', 'array');
    edge(host, 'listeners', set);
    edge(set, 'table', table, 'internal');
    listeners.forEach((fn, i) => edge(table, 4 + i * 2, fn, 'internal'));
    return set;
  };
  const snapshot = {
    nodes: {
      get length() {
        return nodes.length;
      },
      forEach: cb => nodes.forEach(cb),
    },
    getNodeById: id => nodes.find(n => n.id === id) ?? null,
  };
  return {node, edge, callback, bind, registry, listenerSet, snapshot};
}

test('fresh binds to one receiver are duplicates; another receiver stays separate', () => {
  const g = graph();
  const fn = g.callback();
  const a = g.node('Subscriber');
  const b = g.node('Subscriber');
  g.registry([g.bind(fn, a), g.bind(fn, a), g.bind(fn, b)]);
  const regs = collectRegistrations(g.snapshot).filter(
    r => r.event === 'change',
  );
  const {duplicates, perCode} = duplicateGroups(regs);
  assert.deepEqual(
    regs.map(r => r.subscriber),
    [a.id, a.id, b.id],
  );
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].registrations, 2);
  assert.equal(duplicates[0].closures, 2);
  assert.equal(perCode[0].subscribers, 2);
});

test('nested binds retain the original receiver and underlying callback code', () => {
  const g = graph();
  const fn = g.callback();
  const a = g.node('Subscriber');
  const b = g.node('Subscriber');
  g.registry([g.bind(fn, a), g.bind(g.bind(fn, a), b)]);
  const {duplicates} = duplicateGroups(collectRegistrations(g.snapshot));
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].subscriber, a.id);
  assert.equal(duplicates[0].registrations, 2);
});

test('explicit subscription context takes precedence; null binds remain context-less', () => {
  const g = graph();
  const fn = g.callback();
  const receiver = g.node('BoundSubscriber');
  const context = g.node('ExplicitSubscriber');
  const record = g.node('Subscription');
  g.edge(record, 'callback', g.bind(fn, receiver));
  g.edge(record, 'context', context);
  const nil = g.node('null', 'hidden');
  g.registry([record, g.bind(fn, nil), g.bind(fn, nil)]);
  const regs = collectRegistrations(g.snapshot).filter(
    r => r.event === 'change',
  );
  assert.deepEqual(
    regs.map(r => r.subscriber),
    [context.id, 0, 0],
  );
  assert.equal(duplicateGroups(regs).duplicates.length, 0);
});

test('single-listener events and Sets are collected without widening registry shape', () => {
  const g = graph();
  g.registry([g.callback()]);
  g.listenerSet([g.callback()]);
  const notARegistry = g.node('Object');
  const list = g.node('Array');
  g.edge(notARegistry, 'onlyOneArray', list);
  g.edge(list, 0, g.callback(), 'element');
  const regs = collectRegistrations(g.snapshot);
  assert.equal(regs.length, 3);
  assert.equal(regs.filter(r => r.kind === 'emitter').length, 2);
  assert.equal(regs.filter(r => r.kind === 'set').length, 1);
  assert.equal(duplicateGroups(regs).duplicates.length, 0);
});

async function render(snapshots) {
  clearAllSnapshots();
  try {
    snapshots.forEach((snapshot, i) => {
      setSnapshot(
        snapshot,
        `/tmp/duplicate-subscriptions-test-${i}.heapsnapshot`,
        {
          fileName: `s${i + 1}.heapsnapshot`,
          nodeCount: snapshot.nodes.length,
          edgeCount: 0,
          totalSize: 0,
          env: 'browser',
        },
        {replace: false},
      );
    });
    let handler;
    registerDuplicateSubscriptions({
      tool: (_name, _description, _schema, cb) => {
        handler = cb;
      },
    });
    const result = await handler({limit: 15});
    assert.notEqual(result.isError, true);
    return result.content.map(c => c.text ?? '').join('\n');
  } finally {
    clearAllSnapshots();
  }
}

test('largest groups apply the threshold to folded totals, including small stores', async () => {
  const g = graph();
  for (const count of [10, 10, 1]) {
    g.registry(Array.from({length: count}, () => g.callback()));
  }
  const text = (await render([g.snapshot])).replace(/ +/g, ' ');
  assert.match(text, /The largest \(store, event, callback\) groups/);
  assert.match(
    text,
    /Collection\._events` ×3 stores\s*\| `change` \| `onChange` \| 21 \| 0 \|/,
  );
  assert.doesNotMatch(text, /\| `other` \|/);
});

test('growth includes registrations spread across one-listener events and Sets', async () => {
  const rungs = [1, 2].map(count => {
    const g = graph();
    for (let i = 0; i < count; i++) {
      g.registry([g.callback()]);
      g.listenerSet([g.callback()]);
    }
    return g.snapshot;
  });
  const text = (await render(rungs)).replace(/ +/g, ' ');
  assert.match(
    text,
    /Collection\._events` \| `change` \| `onChange` \| 1 \| 2 \| \+1 \|/,
  );
  assert.match(
    text,
    /Subject\.listeners` \| — \| `onChange` \| 1 \| 2 \| \+1 \|/,
  );
});
