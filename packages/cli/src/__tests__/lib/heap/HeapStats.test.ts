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
import type {HeapStats} from '../../../lib/heap/HeapStats';

import {config, dumpNodeHeapSnapshot, utils} from '@memlab/core';
import {
  computeHeapStats,
  getExtraNativeBytes,
  getScriptSourceNodes,
} from '../../../lib/heap/HeapStats';

const timeout = 5 * 60 * 1000;

let snapshot: IHeapSnapshot;
let stats: HeapStats;
// retained until the snapshot is taken
const kept: {buffer?: Uint8Array; array?: string[]; text?: string} = {};

beforeAll(async () => {
  config.isTest = true;
  kept.buffer = new Uint8Array(4 * 1024 * 1024);
  kept.array = Array.from({length: 100000}, (_, i) => `item ${i}`);
  kept.text = 'memlab heap-stats probe '.repeat(40000);
  snapshot = await utils.getSnapshotFromFile(dumpNodeHeapSnapshot(), {});
  stats = computeHeapStats(snapshot);
}, timeout);

test('totals every node self size', () => {
  let selfTotal = 0;
  snapshot.nodes.forEach(node => {
    selfTotal += node.self_size;
  });
  expect(stats.total).toBe(selfTotal + stats.extraNativeBytes);
  expect(stats.extraNativeBytes).toBe(getExtraNativeBytes(snapshot));
});

test('splits the total into V8 heap and native memory that add up', () => {
  const {v8Heap, native, total} = stats;
  expect(v8Heap.total + native.total).toBe(total);
  expect(
    v8Heap.code +
      v8Heap.strings +
      v8Heap.jsArrays +
      v8Heap.system +
      v8Heap.other,
  ).toBe(v8Heap.total);
});

test('attributes typed arrays, JS arrays and strings', () => {
  // the 4 MB Uint8Array backing store is native memory
  expect(stats.native.typedArrays).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  // 100,000 elements of 8 bytes each in the array's own elements store
  expect(stats.v8Heap.jsArrays).toBeGreaterThanOrEqual(100000 * 8);
  // the ~960 KB repeated string plus 100,000 item strings
  expect(stats.v8Heap.strings).toBeGreaterThan(960000);
});

test('splits node memory by why it exists', () => {
  const {composition, total, extraNativeBytes} = stats;
  expect(
    composition.scriptSource + composition.compiledCode + composition.other,
  ).toBe(total - extraNativeBytes);
  // Node.js keeps the source of the modules it has loaded
  expect(getScriptSourceNodes(snapshot).size).toBeGreaterThan(0);
  expect(composition.scriptSource).toBeGreaterThan(0);
  expect(composition.compiledCode).toBeGreaterThan(0);
});
