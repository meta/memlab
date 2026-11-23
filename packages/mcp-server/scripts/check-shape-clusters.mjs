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
 * Unit tests for `shapeClusters` (tools/shape-clusters.ts).
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
const built = path.join(here, '..', 'dist', 'tools', 'shape-clusters.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-shape-clusters: dist/tools/shape-clusters.js is missing; build first.',
  );
  process.exit(1);
}
const {shapeClusters} = await import(pathToFileURL(built).href);

function graph() {
  const list = [];
  const node = (name, self, retained, type = 'object', dom = null) => {
    const n = {
      id: 10 + list.length,
      name,
      type,
      self_size: self,
      retainedSize: retained,
      nodeIndex: list.length,
      references: [],
      dominatorNode: null,
    };
    n.dominatorNode = dom ?? n;
    list.push(n);
    return n;
  };
  const prop = (from, name, to) =>
    from.references.push({type: 'property', name_or_index: name, toNode: to});
  const snapshot = {
    nodes: {
      get length() {
        return list.length;
      },
      forEach: cb => list.forEach(cb),
      get: i => list[i] ?? null,
    },
  };
  return {node, prop, snapshot};
}

test('ranks by what cutting every instance frees, counting nested ones once', () => {
  const g = graph();
  const root = g.node('(GC roots)', 0, 0, 'synthetic');
  const fn = g.node('wrapped', 20, 20, 'closure', root);
  // 60 flat wrapper records, 100 B retained each, 2 closures each.
  for (let i = 0; i < 60; i++) {
    const r = g.node('Record', 40, 100, 'object', root);
    g.prop(r, 'interceptor', fn);
    g.prop(r, 'dispatcher', fn);
  }
  // A 60-long list whose head dominates the rest: only the head counts.
  let up = root;
  const cells = [];
  for (let i = 0; i < 60; i++) {
    const c = g.node('Cell', 16, 16 * (60 - i), 'object', up);
    cells.push(c);
    up = c;
  }
  for (let i = 0; i + 1 < cells.length; i++)
    g.prop(cells[i], 'next', cells[i + 1]);
  g.prop(cells[59], 'next', root);
  // Too few to be a cluster.
  for (let i = 0; i < 10; i++)
    g.prop(g.node('Rare', 999, 999_999, 'object', root), 'x', fn);

  const rows = shapeClusters(g.snapshot);
  assert.deepEqual(
    rows.map(r => r.cls),
    ['Record', 'Cell'],
  );
  const [rec, cell] = rows;
  assert.equal(rec.count, 60);
  assert.equal(rec.frees, 6000);
  assert.equal(rec.closuresEach, 2);
  assert.deepEqual(rec.props, ['dispatcher', 'interceptor']);
  assert.equal(cell.count, 60);
  assert.equal(cell.frees, 16 * 60);
});
