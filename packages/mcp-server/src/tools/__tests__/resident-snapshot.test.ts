/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapSnapshot} from '@memlab/core';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, beforeEach, test} from 'node:test';
import memlabCore from '@memlab/core';
import memlabHeapAnalysis from '@memlab/heap-analysis';
import {
  clearAllSnapshots,
  getCurrentHandle,
  getSnapshotByHandle,
  setSnapshot,
} from '../../heap-state.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlab-resident-'));
const file = path.join(dir, 'rung.heapsnapshot');
fs.writeFileSync(file, '');
fs.truncateSync(file, 2 * 1024 * 1024);
const alias = path.join(dir, 'alias.heapsnapshot');
fs.symlinkSync(file, alias);
const snapshot = {
  nodes: [
    {
      id: 5,
      name: 'Store',
      type: 'object',
      references: [],
      referrers: [],
      edge_count: 0,
      forEachReference(fn: (edge: unknown) => void) {
        this.references.forEach(fn);
      },
      retainedSize: 2048,
    },
  ],
} as unknown as IHeapSnapshot;
const loads: string[] = [];
const originalLightLoad = memlabCore.utils.getSnapshotFromFile;
const originalFullLoad = memlabHeapAnalysis.getFullHeapFromFile;
memlabCore.utils.getSnapshotFromFile = async () => {
  loads.push('light');
  return snapshot;
};
Object.assign(memlabHeapAnalysis, {
  getFullHeapFromFile: async () => {
    loads.push('full');
    return snapshot;
  },
});

// The tools capture the full loader on import.
const {measureLadder, parseLocator} = await import('../collection-trend.js');
const {registerCollectionDiff} = await import('../collection-diff.js');
const {registerVerifyFix} = await import('../verify-fix.js');

type Result = {
  isError?: boolean;
  content: Array<{type: string; text?: string}>;
};
type Handler = (args: Record<string, unknown>) => Promise<Result>;
function handler(register: (server: McpServer) => void): Handler {
  let run: Handler | undefined;
  register({
    tool(_name: string, _description: string, _schema: unknown, fn: Handler) {
      run = fn;
    },
  } as unknown as McpServer);
  assert.ok(run);
  return run;
}
const collectionDiff = handler(registerCollectionDiff);
const verifyFix = handler(registerVerifyFix);
const calls = [
  {
    name: 'collection_trend',
    full: false,
    run: async (p: string, limit: number) => {
      const result = await measureLadder(
        [p, p],
        [parseLocator('Store.cache')],
        limit,
      );
      assert.equal(result.perRung[0].get('Store.cache')?.owners, 1);
    },
  },
  ...[false, true].map(full => ({
    name: `collection_diff include_objects=${full}`,
    full,
    run: async (p: string, limit: number) => {
      const result = await collectionDiff({
        paths: [p, p],
        min_growth: 1,
        limit: 10,
        monotonic_only: false,
        rank_by: 'bytes',
        include_objects: full,
        object_min_edge_growth: 20,
        object_min_retained_kb: 50,
        max_file_size_mb: limit,
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
    },
  })),
  ...[false, true].map(full => ({
    name: `verify_fix ${full ? 'retained_size' : 'class_count'}`,
    full,
    run: async (p: string, limit: number) => {
      const result = await verifyFix({
        before_paths: [p, p],
        after_paths: [p, p],
        metric_kind: full ? 'retained_size' : 'class_count',
        locator: 'Store',
        chain_edge: 'next',
        cycles: 1,
        expected_reduction: 0.9,
        max_file_size_mb: limit,
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const text = result.content.map(c => c.text ?? '').join('\n');
      assert.match(
        text,
        full ? /before series: 2\.0 KB → 2\.0 KB/ : /before series: 1 → 1/,
      );
    },
  })),
];

function makeResident(light = false): string {
  return setSnapshot(snapshot, file, {
    fileName: path.basename(file),
    nodeCount: 1,
    edgeCount: 0,
    totalSize: 2048,
    env: 'unknown',
    light,
  }).handle;
}

beforeEach(() => {
  clearAllSnapshots();
  loads.length = 0;
});
after(() => {
  clearAllSnapshots();
  memlabCore.utils.getSnapshotFromFile = originalLightLoad;
  Object.assign(memlabHeapAnalysis, {getFullHeapFromFile: originalFullLoad});
  fs.rmSync(dir, {recursive: true, force: true});
});

for (const call of calls) {
  for (const [spelling, p] of [
    ['absolute', file],
    ['relative', path.relative(process.cwd(), file)],
    ['symlink', alias],
  ]) {
    test(`${call.name}: reuses resident ${spelling} path above the limit`, async () => {
      const resident = makeResident();
      const active = setSnapshot(
        snapshot,
        path.join(dir, 'other.heapsnapshot'),
        {
          fileName: 'other.heapsnapshot',
          nodeCount: 1,
          edgeCount: 0,
          totalSize: 2048,
          env: 'unknown',
        },
        {replace: false},
      ).handle;
      await call.run(p, 1);
      assert.deepEqual(loads, []);
      assert.equal(getCurrentHandle(), active);
      assert.equal(getSnapshotByHandle(resident), snapshot);
    });
  }
  test(`${call.name}: refuses a nonresident file above the limit before parsing`, async () => {
    await assert.rejects(call.run(file, 1), /over the max_file_size_mb/);
    assert.deepEqual(loads, []);
  });
  test(`${call.name}: preserves the light/full parse for nonresident files`, async () => {
    await call.run(file, 3);
    assert.ok(loads.length > 0);
    assert.ok(loads.every(mode => mode === (call.full ? 'full' : 'light')));
    assert.equal(getCurrentHandle(), null);
  });
  test(`${call.name}: handles a LIGHT resident without re-parsing or silent retained zeros`, async () => {
    const active = makeResident(true);
    if (call.full) {
      await assert.rejects(call.run(file, 1), /LIGHT mode.*Reload/s);
    } else {
      await call.run(file, 1);
    }
    assert.deepEqual(loads, []);
    assert.equal(getCurrentHandle(), active);
  });
}
