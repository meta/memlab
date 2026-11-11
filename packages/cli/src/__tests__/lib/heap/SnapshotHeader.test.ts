/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import {config, dumpNodeHeapSnapshot, utils} from '@memlab/core';
import {
  estimateAnalysisHeapMB,
  readSnapshotHeader,
  suggestHeapLimitMB,
} from '../../../lib/heap/SnapshotHeader';

const timeout = 5 * 60 * 1000;

let tmpDir = '';

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlab-snapshot-header-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

beforeEach(() => {
  config.isTest = true;
});

function writeFile(name: string, content: string | Buffer): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, content);
  return file;
}

function headerJson(snapshot: Record<string, unknown>): string {
  return (
    JSON.stringify({snapshot}).slice(0, -1) +
    ',\n"nodes":[],\n"edges":[],\n"strings":[]}'
  );
}

test(
  'reads the counts of a real snapshot without parsing it',
  async () => {
    const file = dumpNodeHeapSnapshot();
    const header = readSnapshotHeader(file);
    const heap = await utils.getSnapshotFromFile(file, {});
    expect(header.nodeCount).toBe(heap.nodes.length);
    expect(header.edgeCount).toBe(heap.edges.length);
    expect(header.fileSizeBytes).toBe(fs.statSync(file).size);
    expect(header.nodeFields).toContain('self_size');
    expect(header.hasAllocationStacks).toBe(false);
  },
  timeout,
);

test('reads the optional header fields', () => {
  const file = writeFile(
    'full.heapsnapshot',
    headerJson({
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size', 'detachedness'],
      },
      node_count: 10,
      edge_count: 25,
      trace_function_count: 7,
      extra_native_bytes: 4096,
    }),
  );
  expect(readSnapshotHeader(file)).toMatchObject({
    nodeCount: 10,
    edgeCount: 25,
    traceFunctionCount: 7,
    extraNativeBytes: 4096,
    hasDetachedness: true,
    hasAllocationStacks: true,
  });
});

test('defaults the fields an older snapshot does not have', () => {
  const file = writeFile(
    'minimal.heapsnapshot',
    headerJson({meta: {node_fields: ['type']}, node_count: 1, edge_count: 0}),
  );
  expect(readSnapshotHeader(file)).toMatchObject({
    traceFunctionCount: 0,
    extraNativeBytes: 0,
    hasDetachedness: false,
    hasAllocationStacks: false,
  });
});

test('reads a header that spans several read chunks', () => {
  const longNames = Array.from({length: 5000}, (_, i) => `field_${i}`);
  const file = writeFile(
    'long-header.heapsnapshot',
    headerJson({
      meta: {node_fields: longNames, note: 'é'.repeat(70000)},
      node_count: 3,
      edge_count: 4,
    }),
  );
  const header = readSnapshotHeader(file);
  expect(header.nodeCount).toBe(3);
  expect(header.nodeFields.length).toBe(5000);
});

test('rejects files that are not heap snapshots', () => {
  const notSnapshot = writeFile('not-a-snapshot.json', '{"hello": "world"}');
  expect(() => readSnapshotHeader(notSnapshot)).toThrow(/not a heap snapshot/);
  const gzipped = writeFile(
    'compressed.heapsnapshot.gz',
    zlib.gzipSync(headerJson({node_count: 1, edge_count: 1})),
  );
  expect(() => readSnapshotHeader(gzipped)).toThrow(/gzip-compressed/);
});

test('projects the analysis heap from node and edge counts', () => {
  // 140 bytes per node + 12 bytes per edge
  expect(estimateAnalysisHeapMB({nodeCount: 0, edgeCount: 0})).toBe(0);
  expect(
    estimateAnalysisHeapMB({nodeCount: 10_000_000, edgeCount: 40_000_000}),
  ).toBe(Math.ceil((10_000_000 * 140 + 40_000_000 * 12) / (1024 * 1024)));
});

test('suggests a heap limit only when the projection does not fit', () => {
  expect(suggestHeapLimitMB(1000, 4096)).toBeNull();
  // 80% of 4096 MB is the most a projection may use
  expect(suggestHeapLimitMB(3276, 4096)).toBeNull();
  expect(suggestHeapLimitMB(3500, 4096)).toBe(5120);
  expect(suggestHeapLimitMB(7000, 4096)).toBe(9216);
});
