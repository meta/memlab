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
 * Unit tests for shape-families.ts: the leak report's split of the `Object`
 * row by property shape.
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
const built = path.join(here, '..', 'dist', 'shape-families.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-shape-families: dist/shape-families.js is missing; build first.',
  );
  process.exit(1);
}
const {familyOfShape, objectShapeKey, shapeFamiliesSection} = await import(
  pathToFileURL(built).href
);

const families = [
  {id: 'pts', label: 'points', shapes: [['data', 'timestamp']]},
];

test('familyOfShape matches a family whose shape is a subset', () => {
  assert.equal(
    familyOfShape(['data', 'timestamp', 'type'], families).id,
    'pts',
  );
  assert.equal(familyOfShape(['data', 'type'], families), null);
});

test('objectShapeKey sorts property edges and skips __proto__ and elements', () => {
  const node = {
    references: [
      {type: 'property', name_or_index: 'type'},
      {type: 'element', name_or_index: 0},
      {type: 'property', name_or_index: '__proto__'},
      {type: 'property', name_or_index: 'data'},
    ],
  };
  assert.equal(objectShapeKey(node), 'data,type');
});

test('shapeFamiliesSection names the owner and marks unknown shapes NEW', () => {
  const rows = [
    {
      key: 'data,timestamp,type',
      props: ['data', 'timestamp', 'type'],
      counts: [85, 4688],
      delta: 4603,
    },
    {
      key: 'bottom,left',
      props: ['bottom', 'left'],
      counts: [47, 4357],
      delta: 4310,
    },
  ];
  const owners = new Map([
    [
      'data,timestamp,type',
      {module: 'InteractionTracingMetrics', votes: 8, of: 8},
    ],
  ]);
  const lines = shapeFamiliesSection(rows, owners, families, 100, 42008);
  assert.match(lines[2], /The `Object` row \(\+42,008\)/);
  assert.ok(
    lines.includes(
      '| `{data,timestamp,type}` | 85 | 4,688 | +4,603 | 46.03 | InteractionTracingMetrics (8/8) | known: `pts` |',
    ),
  );
  assert.ok(
    lines.includes(
      '| `{bottom,left}` | 47 | 4,357 | +4,310 | 43.10 | ? | **NEW** |',
    ),
  );
});
