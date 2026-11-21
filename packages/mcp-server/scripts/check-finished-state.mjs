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
 * Unit tests for `memlab_finished_state` (tools/finished-state.ts): which
 * field values read as finished, the owned-buffer descent (including a
 * co-held trace context), grouping, and the same-id growth note.
 *
 *   npm run build-pkg && npm run test-units
 *
 * Runs against the BUILT dist/, on fake nodes.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.join(here, '..', 'dist', 'tools', 'finished-state.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-finished-state: dist/tools/finished-state.js is missing; build first.',
  );
  process.exit(1);
}
const {
  finishedEvidence,
  biggestBuffer,
  heldBytes,
  findFinishedState,
  finishedStateBytes,
  finishedStateSweepSection,
  growthNote,
} = await import(pathToFileURL(built).href);

let nextId = 1000;
function node(name, type = 'object', props = {}, extra = {}) {
  const n = {
    id: nextId++,
    name,
    type,
    self_size: 16,
    retainedSize: 16,
    isString: type === 'string',
    references: [],
    referrers: [],
    dominatorNode: null,
    toStringNode() {
      return {stringValue: name};
    },
    ...extra,
  };
  for (const [k, v] of Object.entries(props)) link(n, k, v);
  return n;
}
function link(from, name, to, type = 'property') {
  const e = {type, name_or_index: name, fromNode: from, toNode: to};
  from.references.push(e);
  to.referrers.push(e);
  return to;
}
function own(parent, child, bytes) {
  child.dominatorNode = parent;
  child.retainedSize = bytes;
  return child;
}
const str = s => node(s, 'string');
function oddball(value) {
  const o = node('system / Oddball', 'hidden');
  link(o, '0', str(value), 'hidden');
  return o;
}
function array(n, mk = () => node('Object')) {
  const a = node('Array');
  const els = node('(object elements)', 'array');
  link(a, 'elements', els, 'internal');
  for (let i = 0; i < n; i++) link(els, i, mk(i), 'element');
  return a;
}
function emptyMap() {
  const m = node('Map');
  link(m, 'table', node('(table)', 'array'), 'internal');
  return m;
}
function fakeSnapshot(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  return {
    nodes: {forEach: f => nodes.forEach(f), length: nodes.length},
    getNodeById: id => byId.get(id) ?? null,
  };
}

test('terminal status strings, flags and stamps read as finished', () => {
  const s = v => ({kind: 'string', key: JSON.stringify(v)});
  assert.equal(
    finishedEvidence('traceStatus', s('SUCCESS')),
    'traceStatus="SUCCESS"',
  );
  assert.equal(
    finishedEvidence('status', s('UPLOAD_PENDING')),
    'status="UPLOAD_PENDING"',
  );
  assert.equal(finishedEvidence('state', s('Cancelled')), 'state="Cancelled"');
  assert.equal(finishedEvidence('status', s('pending')), null);
  assert.equal(finishedEvidence('state', s('playing')), null);
  // Not a status field, or a React hook's state slot.
  assert.equal(finishedEvidence('type', s('done')), null);
  assert.equal(finishedEvidence('memoizedState', s('done')), null);
  const t = {kind: 'other', key: 'true'};
  assert.equal(finishedEvidence('completed', t), 'completed=true');
  assert.equal(finishedEvidence('isDone', t), 'isDone=true');
  assert.equal(
    finishedEvidence('wasCanceled', {kind: 'other', key: 'false'}),
    null,
  );
  assert.equal(finishedEvidence('enabled', t), null);
  // A completion stamp: decoded, or a heap number when values are not captured.
  assert.equal(
    finishedEvidence('completed', {kind: 'number', key: '5908.8', num: 5908.8}),
    'completed=5,909',
  );
  assert.equal(
    finishedEvidence('completed', {kind: 'number', key: '0', num: 0}),
    null,
  );
  assert.equal(
    finishedEvidence('completedAt', {kind: 'number', key: '#9'}, 'heap number'),
    'completedAt=<number>',
  );
  assert.equal(
    finishedEvidence('completed', {kind: 'number', key: '#9'}, 'smi number'),
    null,
  );
});

/** A finished trace: {traceStatus, reactRender: {root: [...], page: [...]}}. */
function trace(samples, holderName = 'tracedInteraction') {
  const ctx = node('system / Context');
  const t = node('Object', 'object', {traceStatus: str('SUCCESS')});
  link(ctx, holderName, t, 'context');
  own(ctx, t, 0);
  const rr = own(t, link(t, 'reactRender', node('Object')), 0);
  let total = 0;
  for (const key of ['root', 'page', 'CometApp']) {
    const a = own(rr, link(rr, key, array(samples)), samples * 100);
    total += a.retainedSize;
  }
  rr.retainedSize = total;
  own(t, link(t, 'commitSet', node('Set')), 500);
  t.retainedSize = total + 600;
  return {t, ctx, rr};
}

test('the owned buffer of a finished trace is its table of arrays', () => {
  const {t} = trace(100);
  const b = biggestBuffer(t);
  assert.equal(b.path, 'reactRender');
  assert.equal(b.keys, 3);
  assert.equal(b.entries, 300);
  assert.equal(b.bytes, 30_000);
});

test('a trace context held with its provider still counts (co-held)', () => {
  // WebLoomCore.$4 entry {status:"UPLOAD_PENDING", traceContext}, where the
  // context is also held by the provider, so the entry dominates nothing.
  const entry = node('Object', 'object', {status: str('UPLOAD_PENDING')});
  entry.retainedSize = 28;
  const tc = link(entry, 'traceContext', node('Object'));
  tc.retainedSize = 90_000;
  link(node('Provider'), '$1', tc);
  const buf = own(tc, link(tc, 'buffer', node('WebLoomEventBuffer')), 89_000);
  own(buf, link(buf, '$1', array(40)), 88_000);
  assert.equal(heldBytes(entry), 90_028);
  const b = biggestBuffer(entry);
  assert.equal(b.path, 'traceContext.buffer.$1');
  assert.equal(b.entries, 40);
  // Held by more than 4: not co-held, not counted.
  for (let i = 0; i < 4; i++) link(node('Other'), 'x', tc);
  assert.equal(heldBytes(entry), 28);
});

test('groups by holder and value; skips small, unbuffered and product rows', () => {
  const {t, ctx, rr} = trace(400);
  // A numeric status counts only with its observers empty.
  const pool = node('RelayAsyncStreamPool');
  const map = link(pool, '$2', node('Map'));
  const streams = [];
  for (let i = 0; i < 3; i++) {
    const e = node('Object', 'object', {
      status: node('smi number', 'number'),
      observers: emptyMap(),
    });
    own(map, e, 40_000);
    own(e, link(e, 'events', array(2)), 39_000);
    link(map, i + 1, e, 'internal');
    streams.push(e);
  }
  const busy = node('Object', 'object', {
    status: node('smi number', 'number'),
    observers: (() => {
      const m = node('Map');
      const tbl = link(m, 'table', node('(table)', 'array'), 'internal');
      link(tbl, 0, str('k'), 'internal');
      link(tbl, 1, node('Observer'), 'internal');
      return m;
    })(),
  });
  own(busy, link(busy, 'events', array(5)), 90_000);
  busy.retainedSize = 91_000;
  // A finished request whose big child is its response: its product.
  const req = node('Object', 'object', {status: str('SUCCESS')});
  own(req, link(req, 'response', array(20)), 200_000);
  req.retainedSize = 200_100;
  const nodes = [t, ctx, rr, pool, map, ...streams, busy, req];
  const rows = findFinishedState(fakeSnapshot(nodes));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].evidence, 'traceStatus="SUCCESS"');
  assert.equal(rows[0].holder, 'closure var tracedInteraction');
  assert.equal(rows[0].buffer.entries, 1200);
  assert.equal(rows[1].count, 3);
  assert.match(rows[1].evidence, /^status=<number>, observers empty$/);
  const lines = finishedStateSweepSection(fakeSnapshot(nodes), {cap: 1});
  assert.match(lines[0], /\(1 of 2 groups;/);
  assert.equal(finishedStateSweepSection(fakeSnapshot([req])).length, 0);
});

test('a sweep lead cuts the 10 largest retained roots of each group', () => {
  const pool = node('RelayAsyncStreamPool');
  const map = link(pool, '$2', node('Map'));
  const streams = [];
  for (let i = 0; i < 12; i++) {
    const e = node('Object', 'object', {
      status: node('smi number', 'number'),
      observers: emptyMap(),
    });
    own(map, e, 40_000 + i * 1000);
    own(e, link(e, 'events', array(2)), 39_000);
    link(map, i + 1, e, 'internal');
    streams.push(e);
  }
  const leads = [];
  const lines = finishedStateSweepSection(
    fakeSnapshot([pool, map, ...streams]),
    {
      leads,
    },
  );
  assert.ok(lines.length > 0);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].section, 6);
  assert.match(
    leads[0].label,
    /finished \(status=<number>, observers empty\)$/,
  );
  assert.equal(leads[0].bytes, 12 * 40_000 + 66_000);
  assert.deepEqual(
    leads[0].ids,
    streams
      .slice(2)
      .reverse()
      .map(e => e.id),
  );
});

test('co-held contexts are counted once per group and across groups', () => {
  const tc = node('Object', 'object', {}, {retainedSize: 90_000});
  const buffer = own(tc, link(tc, 'buffer', array(40)), 89_000);
  link(node('Provider'), 'context', tc);
  const entries = [];
  const registry = node('Registry');
  for (let i = 0; i < 2; i++) {
    const entry = node('Object', 'object', {status: str('UPLOAD_PENDING')});
    entry.retainedSize = 28;
    link(entry, 'traceContext', tc);
    link(registry, 'entry', entry);
    entries.push(entry);
  }
  const snapshot = fakeSnapshot(entries);
  const rows = findFinishedState(snapshot, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].bytes, 90_056);
  assert.equal(findFinishedState(snapshot, 100_000).length, 0);
  assert.equal(rows[0].buffer.bytes, buffer.retainedSize);

  entries[1].references.find(e => e.name_or_index === 'status').toNode =
    str('SUCCESS');
  const separate = findFinishedState(snapshot, 1);
  assert.equal(separate.length, 2);
  assert.equal(finishedStateBytes(separate), 90_056);
});

test('duplicate shared edges and dominated subtrees do not inflate bytes', () => {
  const holder = node('Holder', 'object', {}, {retainedSize: 28});
  const tc = link(holder, 'context', node('Object'));
  tc.retainedSize = 90_000;
  const buffer = own(tc, link(tc, 'buffer', array(40)), 89_000);
  link(holder, 'alsoContext', tc);
  link(holder, 'alsoBuffer', buffer);
  assert.equal(heldBytes(holder), 90_028);
});

function number(value) {
  return node('heap number', 'number', {value: str(String(value))});
}

function timedTrace(stamp, times, field = 'completed') {
  const {t, ctx, rr} = trace(400);
  link(t, field, number(stamp));
  for (const edge of rr.references) {
    const elements = edge.toNode.references[0].toNode.references;
    for (let i = 0; i < elements.length; i++) {
      link(elements[i].toNode, 'timestamp', number(times[i % times.length]));
    }
  }
  return fakeSnapshot([t, ctx, rr]);
}

test('completion comparisons require a matching inferred clock', () => {
  const times = [120_000, 180_000];
  const note = stamp => findFinishedState(timedTrace(stamp, times), 1)[0].times;
  assert.match(note(120_000), /newest 60.0 s AFTER completion/);
  assert.match(note(180_000), /none after completion/);
  assert.match(note(5_909), /newest .* AFTER completion/);
  for (const stamp of [1_790_000_000_000, 1_790_000_000, 100_000_000_000]) {
    assert.doesNotMatch(note(stamp), /AFTER completion|none after completion/);
  }
  const epoch = [1_790_000_000_000, 1_790_000_060_000];
  assert.doesNotMatch(
    findFinishedState(timedTrace(120_000, epoch), 1)[0].times,
    /AFTER completion|none after completion/,
  );
});

test('timestamp-only evidence groups by field, not exact timestamp', () => {
  const registry = node('Registry');
  const entries = [];
  for (const stamp of [120_000, 180_000, 240_000]) {
    const entry = node('Object', 'object', {completedAt: number(stamp)});
    entry.retainedSize = 40_000;
    own(entry, link(entry, 'events', array(2)), 39_000);
    link(registry, 'entry', entry);
    entries.push(entry);
  }
  const rows = findFinishedState(fakeSnapshot(entries));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 3);
  assert.equal(rows[0].bytes, 120_000);
  assert.match(rows[0].evidence, /^completedAt=/);
  const differentField = node('Object', 'object', {
    finishedAt: number(120_000),
  });
  differentField.retainedSize = 40_000;
  own(differentField, link(differentField, 'events', array(2)), 39_000);
  link(registry, 'entry', differentField);
  assert.equal(
    findFinishedState(fakeSnapshot([...entries, differentField]), 1).length,
    2,
  );
});

test('growth: same id earlier with fewer entries is GROWING', () => {
  const now = trace(2000);
  const then = trace(80);
  then.t.id = now.t.id;
  const rows = findFinishedState(fakeSnapshot([now.t, now.ctx, now.rr]), 1);
  const note = growthNote(rows[0], fakeSnapshot([then.t]));
  assert.match(note, /^240→6,000 entries, .*: GROWING$/);
  assert.equal(
    growthNote(rows[0], fakeSnapshot([])),
    'no same-id object earlier',
  );
});
