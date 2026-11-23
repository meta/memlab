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
 * Unit tests for `edgeNameIndex` (edge-name-index.ts) and the eval hint for a
 * full-heap referrer walk (eval-hints.ts).
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
const dist = path.join(here, '..', 'dist');
if (!fs.existsSync(path.join(dist, 'edge-name-index.js'))) {
  console.error(
    'check-edge-name-index: dist/edge-name-index.js is missing; build first.',
  );
  process.exit(1);
}
const {edgeNameIndex, isIndexedEdgeName} = await import(
  pathToFileURL(path.join(dist, 'edge-name-index.js')).href
);
const {hintsForEval} = await import(
  pathToFileURL(path.join(dist, 'eval-hints.js')).href
);

function heap() {
  const list = [];
  const node = (id, name) => {
    const n = {
      id,
      name,
      type: 'object',
      nodeIndex: list.length,
      references: [],
      forEachReference(cb) {
        for (const e of this.references) cb(e);
      },
    };
    list.push(n);
    return n;
  };
  const edge = (from, to, name, type = 'property') =>
    from.references.push({
      type,
      name_or_index: name,
      fromNode: from,
      toNode: to,
    });
  const root = node(1, '(GC roots)');
  const a = node(10, 'A');
  const b = node(11, 'B');
  const x = node(20, 'X');
  const y = node(21, 'Y');
  edge(root, a, 'listener');
  edge(a, x, 'listener');
  edge(a, y, 'listener');
  edge(b, x, 'listener', 'internal');
  edge(b, y, 0, 'element');
  edge(b, x, '7', 'internal');
  edge(a, y, 'context', 'context');
  let edges = 0;
  for (const n of list) edges += n.references.length;
  return {
    nodes: {
      forEach: cb => list.forEach(cb),
      get: i => list[i] ?? null,
      length: list.length,
    },
    edges: {length: edges},
  };
}

test('holders and targets of a name, each once, roots left out of holders', () => {
  const index = edgeNameIndex(heap());
  assert.deepEqual(index.holders('listener'), [10, 11]);
  assert.deepEqual(index.holders('listener', new Set(['property'])), [10]);
  assert.deepEqual(index.targets('listener').sort(), [10, 20, 21]);
  assert.deepEqual(index.holders('context'), [10]);
  assert.deepEqual(index.holders('nope'), []);
});

test('element positions and numeric slots are not indexed', () => {
  assert.equal(isIndexedEdgeName('7'), false);
  assert.equal(isIndexedEdgeName('listener'), true);
  assert.deepEqual(edgeNameIndex(heap()).holders('7'), []);
});

test('a full-heap referrers walk gets the indexed-helper hint', () => {
  const hints = hintsForEval(
    "let c = 0; snapshot.nodes.forEach(n => { for (const e of n.referrers) if (e.name_or_index === 'x') c++; }); result = c;",
  );
  assert.match(hints[0]?.tool ?? '', /byReferrerEdge/);
  assert.equal(
    hintsForEval(
      "result = helpers.byReferrerEdge('x').length; snapshot.nodes.forEach(n => n.referrers);",
    ).some(h => /byReferrerEdge/.test(h.tool)),
    false,
  );
});
