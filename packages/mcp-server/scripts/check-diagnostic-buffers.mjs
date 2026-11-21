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
 * Unit tests for `memlab_diagnostic_buffers` (tools/diagnostic-buffers.ts):
 * error grouping by exact message+stack, the record tests, the telemetry
 * name test, realm lookup, scope names and the rendered section.
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
const built = path.join(here, '..', 'dist', 'tools', 'diagnostic-buffers.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-diagnostic-buffers: dist/tools/diagnostic-buffers.js is missing; build first.',
  );
  process.exit(1);
}
const {
  errorGroups,
  isErrorLike,
  isPerfRecord,
  isTelemetryName,
  realmOf,
  renderDiagnosticBuffers,
  scopeNames,
  stringKey,
} = await import(pathToFileURL(built).href);

let nextId = 1;
/** A fake heap node: `refs` is [[edgeType, edgeName, node], ...]. */
function node(name, type = 'object', refs = [], extra = {}) {
  const n = {
    id: nextId++,
    name,
    type,
    self_size: extra.self_size ?? 16,
    retainedSize: extra.retainedSize ?? 16,
    isString: type.includes('string'),
    dominatorNode: extra.dominatorNode ?? null,
    referrers: [],
    references: refs.map(([t, k, to]) => ({
      type: t,
      name_or_index: k,
      toNode: to,
    })),
    getReferenceNode(k, t) {
      const e = this.references.find(
        r => r.name_or_index === k && (t == null || r.type === t),
      );
      return e?.toNode ?? null;
    },
  };
  for (const e of n.references) e.toNode.referrers.push({...e, fromNode: n});
  return n;
}
const str = (value, bytes) =>
  node(value, 'string', [], {
    self_size: bytes ?? value.length + 16,
    retainedSize: bytes ?? value.length + 16,
  });
const error = (msg, stack, retained = 1000) =>
  node(
    'Object',
    'object',
    [
      ['property', 'message', msg],
      ['property', 'stack', stack],
    ],
    {retainedSize: retained},
  );

test('identical message+stack entries are one group; dedupe frees the repeats', () => {
  const m = str('Converting to a string will drop content data');
  const s = str('at a (x.js:1:2)');
  const errs = [error(m, s), error(m, s), error(m, s), error(str('other'), s)];
  const g = errorGroups(errs);
  assert.equal(g.distinct, 2);
  assert.equal(g.topCount, 3);
  assert.equal(g.topVariants, 1);
  assert.match(g.topMessage, /^Converting to a string/);
  // Two repeats of one 1,000-byte record.
  assert.equal(g.dupRecords, 2000);
});

test('copies of equal content in separate strings still count as repeats', () => {
  const errs = [0, 1, 2].map(() => error(str('boom'), str('at f')));
  const g = errorGroups(errs);
  assert.equal(g.distinct, 1);
  assert.equal(
    g.dupText,
    2 * (str('boom').retainedSize + str('at f').retainedSize),
  );
});

test('stacks that differ past the 1,024-char snapshot cap stay apart', () => {
  const head = 'x'.repeat(1024);
  const a = error(str('m'), str(head, 2676));
  const b = error(str('m'), str(head, 2708));
  const g = errorGroups([a, b]);
  assert.equal(g.distinct, 2);
  assert.equal(g.topCount, 2);
  assert.equal(g.topVariants, 2);
  assert.equal(g.dupRecords, 0);
  assert.notEqual(
    stringKey(a.getReferenceNode('stack')),
    stringKey(b.getReferenceNode('stack')),
  );
});

test('a concatenated string keys by its whole content', () => {
  const cons = node('(concatenated string)', 'concatenated string', [
    ['internal', 'first', str('ab')],
    ['internal', 'second', str('cd')],
  ]);
  assert.equal(stringKey(cons), 'abcd');
  assert.equal(stringKey(null), '');
});

test('error-like and performance-entry records', () => {
  assert.equal(isErrorLike(node('TypeError')), true);
  assert.equal(isErrorLike(error(str('m'), str('s'))), true);
  assert.equal(
    isErrorLike(node('Object', 'object', [['property', 'message', str('m')]])),
    false,
  );
  assert.equal(isPerfRecord(node('PerformanceResourceTiming')), true);
  assert.equal(isPerfRecord(node('LayoutShift')), true);
  const t = str('1');
  assert.equal(
    isPerfRecord(
      node('Object', 'object', [
        ['property', 'startTime', t],
        ['property', 'processingStart', t],
      ]),
    ),
    true,
  );
  // A trace span with startTime and duration is the app's own, not the timeline.
  assert.equal(
    isPerfRecord(
      node('Object', 'object', [
        ['property', 'startTime', t],
        ['property', 'duration', t],
      ]),
    ),
    false,
  );
});

test('telemetry names', () => {
  for (const yes of [
    'global:Debug.Logger',
    'BanzaiComet',
    'closure var timerQueue',
    'module:CometRelayEnvironment.__log',
    't.logs',
    '_expiredBatchMap',
  ]) {
    assert.equal(isTelemetryName(yes), true, yes);
  }
  for (const no of [
    'global:ErrorUtils.history',
    'closure var cache',
    'Object.login',
    'catalog',
    'blog.posts',
  ]) {
    assert.equal(isTelemetryName(no), false, no);
  }
});

test('realm: object -> map -> meta-map -> NativeContext', () => {
  const ctx = node('system / NativeContext / https://x.com', 'hidden');
  const meta = node('system / Map', 'object shape', [
    ['internal', 'native_context', ctx],
  ]);
  const map = node('system / Map', 'object shape', [['internal', 'map', meta]]);
  const arr = node('Array', 'object', [['internal', 'map', map]]);
  assert.equal(realmOf(arr)?.id, ctx.id);
  assert.equal(realmOf(node('Array')), null);
});

test('scope names come from the closures sharing the holding context', () => {
  const ctx = node('system / Context', 'object');
  const holder = node('Object', 'object', [], {dominatorNode: ctx});
  const q = node('Array', 'object', [], {dominatorNode: holder});
  node('_expiredBatchMap', 'closure', [['internal', 'context', ctx]]);
  node('_flushBatchMap', 'closure', [['internal', 'context', ctx]]);
  node('queueWork', 'closure', [['internal', 'context', ctx]]);
  assert.deepEqual(scopeNames(q), ['_expiredBatchMap', '_flushBatchMap']);
  assert.deepEqual(scopeNames(node('Array')), []);
});

const row = (over = {}) => ({
  kind: 'perf timeline',
  holder: 'Performance (native timeline)',
  id: 613063,
  entries: 1775,
  bytes: 363624,
  detail: 'ResourceTiming 1,091',
  key: 'perf timeline|0',
  types: {PerformanceResourceTiming: 1091},
  ...over,
});

test('nothing qualifies: no lines at all', () => {
  assert.deepEqual(renderDiagnosticBuffers({rows: [], excluded: []}, 5), []);
});

test('foreign-realm buffers are named in a kept list line', () => {
  const lines = renderDiagnosticBuffers(
    {
      rows: [],
      excluded: [
        {
          id: 5035869,
          what: '940 performance-entry records',
          bytes: 93116,
          realm: 'NativeContext@7901',
        },
      ],
    },
    5,
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^- Left out, not app memory: @5035869/);
});

test('a ladder shows bytes and entry types per rung, capped rows', () => {
  const earlier = [
    [
      row({
        bytes: 311196,
        entries: 1560,
        types: {PerformanceResourceTiming: 1001},
      }),
    ],
    [
      row({
        bytes: 343140,
        entries: 1685,
        types: {PerformanceResourceTiming: 1046},
      }),
    ],
  ];
  const rows = [
    row(),
    row({id: 1, key: 'x', kind: 'telemetry queue', bytes: 10}),
  ];
  const text = renderDiagnosticBuffers({rows, excluded: []}, 1, earlier).join(
    '\n',
  );
  assert.match(text, /303\.9 KB → 335\.1 KB → 355\.1 KB/);
  assert.match(text, /ResourceTiming 1,001 → 1,046 → 1,091/);
  assert.match(text, /1 more row\(s\) not shown/);
  assert.doesNotMatch(text, /@1\b/);
});
