/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode, IHeapSnapshot} from '@memlab/core';

import {analysis, config, dumpNodeHeapSnapshot, utils} from '@memlab/core';
import {findObjects, parseSize} from '../../../lib/heap/FindObjects';

const timeout = 5 * 60 * 1000;

beforeEach(() => {
  config.isTest = true;
});

type FakeNode = Pick<
  IHeapNode,
  'id' | 'name' | 'type' | 'self_size' | 'retainedSize' | 'is_detached'
>;

function fakeSnapshot(nodes: FakeNode[]): IHeapSnapshot {
  return {
    nodes: {
      forEach: (callback: (node: IHeapNode) => void) =>
        nodes.forEach(node => callback(node as IHeapNode)),
    },
  } as unknown as IHeapSnapshot;
}

function node(
  id: number,
  name: string,
  retainedSize: number,
  extra: Partial<FakeNode> = {},
): FakeNode {
  return {
    id,
    name,
    type: 'object',
    self_size: 16,
    retainedSize,
    is_detached: false,
    ...extra,
  };
}

const heap = fakeSnapshot([
  node(1, '(root)', 99999, {type: 'synthetic'}),
  node(5, 'Map', 3000),
  node(7, 'Map', 9000),
  node(9, 'MapIterator', 50000),
  node(11, 'Detached <div>', 400, {type: 'native', is_detached: true}),
  node(13, 'Map', 100, {type: 'closure'}),
  node(15, 'Map', 9000, {self_size: 32}),
]);

class MemlabFindObjectsProbe {
  public payload: string[];
  constructor(size: number) {
    this.payload = Array.from({length: size}, (_, i) => `entry ${i}`);
  }
}

test('parses sizes in bytes and in powers of 1024', () => {
  expect(parseSize('4096')).toBe(4096);
  expect(parseSize('500KB')).toBe(512000);
  expect(parseSize('1.5mb')).toBe(1572864);
  expect(parseSize('2 GB')).toBe(2 * 1024 ** 3);
  expect(parseSize('10b')).toBe(10);
  expect(parseSize('1.5')).toBe(2);
  expect(parseSize('MB')).toBeNull();
  expect(parseSize('-5')).toBeNull();
  expect(parseSize('5 parsecs')).toBeNull();
});

test('applies every filter and skips the synthetic roots', () => {
  expect(findObjects(heap, {}, 10).matchCount).toBe(6);
  const maps = findObjects(heap, {namePattern: /^Map$/}, 10);
  expect(maps.objects.map(o => o.id)).toEqual([15, 7, 5, 13]);
  const objectMaps = findObjects(
    heap,
    {namePattern: /^Map$/, nodeType: 'object', minRetainedSize: 5000},
    10,
  );
  expect(objectMaps.objects.map(o => o.id)).toEqual([15, 7]);
  const detached = findObjects(heap, {detachedOnly: true}, 10);
  expect(detached.objects).toEqual([
    {
      id: 11,
      name: 'Detached <div>',
      type: 'native',
      selfSize: 16,
      retainedSize: 400,
      detached: true,
    },
  ]);
});

test('keeps only the top matches, largest retained size first', () => {
  const result = findObjects(heap, {}, 3);
  expect(result.matchCount).toBe(6);
  // ties on retained size go to the larger self size
  expect(result.objects.map(o => o.id)).toEqual([9, 15, 7]);
});

test(
  'ranks real objects by retained size',
  async () => {
    // retained until the snapshot is taken
    const probes = [100, 3000, 20].map(n => new MemlabFindObjectsProbe(n));
    const snapshot = await utils.getSnapshotFromFile(
      dumpNodeHeapSnapshot(),
      {},
    );
    expect(probes.length).toBe(3);
    analysis.preparePathFinder(snapshot);
    const result = findObjects(
      snapshot,
      {namePattern: /^MemlabFindObjectsProbe$/, nodeType: 'object'},
      10,
    );
    expect(result.matchCount).toBe(3);
    const sizes = result.objects.map(o => o.retainedSize);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    // the 3,000-entry probe retains its array and every string in it
    expect(sizes[0]).toBeGreaterThan(3000 * 16);
    expect(sizes[2]).toBeLessThan(sizes[1]);
  },
  timeout,
);
