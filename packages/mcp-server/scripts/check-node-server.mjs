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
 * Unit tests for `nodeServerFacts` and its flag lines (tools/node-server.ts):
 * realm count, require.cache owners, the request census and the holders of
 * AsyncLocalStorage stores, on a fake heap.
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
const built = path.join(here, '..', 'dist', 'tools', 'node-server.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-node-server: dist/tools/node-server.js is missing; build first.',
  );
  process.exit(1);
}
const {
  cacheKeyLabel,
  nodeServerFacts,
  nodeServerFlagLines,
  nodeServerFindings,
} = await import(pathToFileURL(built).href);

let nextId = 11;
const all = [];
function node(name, type = 'object', retainedSize = 0) {
  const n = {
    id: nextId++,
    name,
    type,
    retainedSize,
    references: [],
    referrers: [],
    isString: type === 'string',
    toStringNode: () => (type === 'string' ? {stringValue: name} : null),
  };
  all.push(n);
  return n;
}
function edge(from, name, to, type = 'property') {
  const e = {name_or_index: name, type, fromNode: from, toNode: to};
  from.references.push(e);
  to.referrers.push(e);
}
const T = node('true', 'hidden');
const F = node('false', 'hidden');
const NULL = node('null', 'hidden');
const UNDEF = node('undefined', 'hidden');

// Two realms.
node('system / NativeContext', 'hidden', 50_000);
node('system / NativeContext', 'hidden', 140_000);

// require.cache with two modules.
const cache = node('Object');
const schema = node('Module');
const schemaExports = node('Object', 'object', 1_000_000);
edge(cache, '/app/node_modules/next/dist/server/config-schema.js', schema);
edge(schema, 'exports', schemaExports);
const small = node('Module');
const smallExports = node('Object', 'object', 2_000);
edge(cache, '/app/server.js', small);
edge(small, 'exports', smallExports);
// A Module referenced under a non-path key is not a cache entry.
const parent = node('Object');
edge(parent, 'main', node('Module'));

// One completed request with its finished response.
const req = node('IncomingMessage', 'object', 2_000);
edge(req, 'complete', T);
edge(req, 'aborted', F);
edge(req, 'url', node('/api/health', 'string'));
edge(req, 'method', node('GET', 'string'));
const res = node('ServerResponse', 'object', 4_000);
edge(res, 'finished', T);
edge(res, 'destroyed', T);
edge(res, 'req', req);
// A prototype named like the class is not an instance.
node('Socket');
const sock = node('Socket');
edge(sock, 'connecting', F);
edge(sock, '<symbol kHandle>', NULL);

// A repeating timer carrying a Next work store plus an empty slot.
const store = node('Object', 'object', 3_000);
edge(store, 'route', node('/api/health', 'string'));
const timer = node('Timeout', 'object', 300);
edge(timer, '_idleTimeout', node('smi number', 'number'));
edge(timer, '_repeat', node('smi number', 'number'));
edge(timer, '_destroyed', F);
edge(timer, '<symbol kResourceStore>', store);
edge(timer, '<symbol kResourceStore>', UNDEF);
const promise = node('Promise');
edge(promise, '<symbol kResourceStore>', store);
// The AsyncLocalStorage's own key is not a store.
const als = node('AsyncLocalStorage');
edge(als, 'kResourceStore', node('symbol', 'symbol'));

const snapshot = {nodes: {forEach: cb => all.forEach(cb)}};

test('cache key labels', () => {
  assert.equal(
    cacheKeyLabel('/app/node_modules/next/dist/server/config-schema.js'),
    '…/next/dist/server/config-schema.js',
  );
  assert.equal(cacheKeyLabel('/app/a/b/c/d.js'), '…/b/c/d.js');
  assert.equal(cacheKeyLabel('/x.js'), '/x.js');
});

test('facts from a fake Node heap', () => {
  const f = nodeServerFacts(snapshot);
  assert.equal(f.realmCount, 2);
  assert.equal(f.realmRetained, 190_000);
  assert.equal(f.cache.length, 2);
  assert.equal(f.cache[0].module.id, schema.id);
  assert.equal(f.cache[0].retained, 1_000_000);
  assert.equal(f.census.get('IncomingMessage').flags.get('complete'), 1);
  assert.equal(f.census.get('ServerResponse').flags.get('finished'), 1);
  assert.equal(f.census.get('Socket').total, 1);
  assert.equal(f.census.get('Socket').flags.get('handle closed'), 1);
  assert.equal(f.census.get('Timeout').flags.get('repeating'), 1);
  assert.equal(f.census.get('Timeout').flags.get('destroyed') ?? 0, 0);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].res.id, res.id);
  assert.equal(f.holders.length, 1);
  assert.equal(f.holders[0].node.id, timer.id);
  assert.equal(f.holders[0].slots, 1);
  assert.deepEqual(f.holders[0].routes, ['/api/health']);
  assert.equal(f.holders[0].example, store.id);
  assert.equal(f.promiseHolders, 1);
});

test('flags only on a Node heap', () => {
  assert.deepEqual(nodeServerFlagLines(snapshot, 'browser'), []);
  assert.deepEqual(nodeServerFindings(snapshot, 'unknown'), []);
  const lines = nodeServerFlagLines(snapshot, 'node').join('\n');
  assert.match(lines, /2 realms \(NativeContexts\), 185\.5 KB/);
  assert.match(lines, /config-schema\.js` 976\.6 KB/);
  assert.match(lines, /1 completed request/);
  assert.equal(nodeServerFindings(snapshot, 'node').length, 1);
});
