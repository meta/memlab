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
 * Unit tests for the pure helpers of `memlab_field_fill`
 * (tools/field-fill.ts): value classification, the per-field audit and the
 * timestamp-scale guess.
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
const built = path.join(here, '..', 'dist', 'tools', 'field-fill.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-field-fill: dist/tools/field-fill.js is missing; build first.',
  );
  process.exit(1);
}
const {classifyValue, auditFields, timestampScale, decodeTimes, isTimeName} =
  await import(pathToFileURL(built).href);

let nextId = 1000;
function node(name, type, props = {}, extra = {}) {
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
}
function oddball(value) {
  const o = node('system / Oddball', 'hidden');
  link(o, '0', node(value, 'string'), 'hidden');
  return o;
}
const NULL = oddball('null');
const UNDEF = oddball('undefined');
const FALSE = oddball('false');
function heapNumber(v) {
  const h = node('heap number', 'number');
  link(h, 'value', node(String(v), 'string'), 'internal');
  return h;
}

test('oddballs decode to null/undefined/boolean', () => {
  assert.equal(classifyValue(NULL).kind, 'nullish');
  assert.equal(classifyValue(UNDEF).key, 'undefined');
  assert.equal(classifyValue(FALSE).kind, 'other');
  assert.equal(classifyValue(FALSE).key, 'false');
});

test('heap numbers decode through their value edge, or stay unreadable', () => {
  assert.equal(classifyValue(heapNumber(1.5)).num, 1.5);
  const bare = node('heap number', 'number');
  assert.equal(classifyValue(bare).num, undefined);
});

test('empty and shared objects', () => {
  const arr = node('Array', 'object');
  assert.equal(classifyValue(arr).empty, true);
  const holder = node('Object', 'object');
  link(holder, 'a', arr);
  assert.equal(classifyValue(arr).shared, false);
  link(node('Object', 'object'), 'b', arr);
  assert.equal(classifyValue(arr).shared, true);
});

test('auditFields: unset fields, copied arrays, owned bytes', () => {
  const recs = [];
  const shared = node('Array', 'object');
  link(shared, '0', node('x', 'string'), 'element');
  for (let i = 0; i < 10; i++) {
    const deps = node('Array', 'object');
    link(deps, '0', node('y', 'string'), 'element');
    const rec = node('Object', 'object', {
      factoryTime: NULL,
      meta: i < 9 ? UNDEF : NULL,
      id: node(`mod${i}`, 'string'),
      dependencies: i === 0 ? shared : deps,
    });
    if (i > 0) deps.dominatorNode = rec;
    recs.push(rec);
  }
  link(node('Object', 'object'), 'other', shared);
  const f = auditFields(recs);
  assert.equal(f.get('factoryTime').nullish, 10);
  assert.equal(f.get('factoryTime').values.get('null'), 10);
  assert.equal(f.get('meta').values.get('undefined'), 9);
  assert.equal(f.get('id').values.size, 10);
  const deps = f.get('dependencies');
  assert.equal(deps.objects, 10);
  assert.equal(deps.shared, 1);
  assert.equal(deps.ownedBytes, 9 * 16);
});

test('distinct strings that share a long prefix stay distinct', () => {
  const p = 'x'.repeat(60);
  const a = classifyValue(node(p + 'a', 'string'));
  const b = classifyValue(node(p + 'b', 'string'));
  assert.notEqual(a.key, b.key);
});

test('timestampScale: epoch ms on any name, perf only on time-like names', () => {
  const epoch = [1702613522670, 1702613522999, 1702613600000];
  assert.equal(timestampScale('defined', epoch).scale, 'epoch ms');
  const perf = [451396, 600000, 432018988];
  assert.equal(timestampScale('startTime', perf).scale, 'performance.now() ms');
  assert.equal(timestampScale('count', perf), null);
  // a clock word inside another word does not count (Next.js `revalidate`)
  assert.equal(isTimeName('revalidate'), false);
  assert.equal(isTimeName('domainLookupStartTime'), true);
  assert.equal(isTimeName('created_at'), true);
  assert.equal(timestampScale('revalidate', [1, 60, 2592000]), null);
  // durations under a minute are not a clock
  assert.equal(timestampScale('factoryTime', [0, 12, 32]), null);
  // integer epoch seconds on a time-like name
  assert.equal(
    timestampScale('creation_time', [1708532911, 1708548583]).scale,
    'epoch s',
  );
  // a 0 sentinel among epoch values is dropped, not stretched into the span
  const withZero = [...Array(40)].map((_, i) => 1708548583709 + i);
  const ts = timestampScale('timestamp', [0, ...withZero]);
  assert.equal(ts.scale, 'epoch ms');
  assert.equal(ts.ms.length, 40);
});

test('decodeTimes: span, rate and age buckets relative to the newest', () => {
  const t = decodeTimes([0, 30_000, 60_000, 120_000, 7_200_000]);
  assert.equal(t.span, 7_200_000);
  assert.equal(t.perMin.toFixed(3), (5 / 120).toFixed(3));
  assert.match(t.hist, /^≤1m 1 · 1–6h 4$/);
});
