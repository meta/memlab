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

import {config, dumpNodeHeapSnapshot, utils} from '@memlab/core';
import {
  buildClassHistogram,
  getClassKey,
  parseNamePattern,
} from '../../../lib/heap/ClassHistogram';

const timeout = 5 * 60 * 1000;

beforeEach(() => {
  config.isTest = true;
});

type FakeNode = Pick<IHeapNode, 'id' | 'type' | 'name' | 'self_size'>;

function fakeSnapshot(nodes: FakeNode[]): IHeapSnapshot {
  return {
    nodes: {
      forEach: (callback: (node: IHeapNode, index: number) => void) =>
        nodes.forEach((node, i) => callback(node as IHeapNode, i)),
    },
  } as unknown as IHeapSnapshot;
}

class MemlabClassHistogramProbe {
  constructor(public label: string) {}
}

test(
  'counts the instances of a class in a real snapshot',
  async () => {
    // retained until the snapshot is taken
    const probes = Array.from(
      {length: 1234},
      (_, i) => new MemlabClassHistogramProbe(`probe ${i}`),
    );
    const file = dumpNodeHeapSnapshot();
    expect(probes.length).toBe(1234);

    const snapshot = await utils.getSnapshotFromFile(file, {
      buildNodeIdIndex: false,
    });
    const histogram = buildClassHistogram(snapshot);
    const row = histogram.rows.find(
      r => r.name === 'MemlabClassHistogramProbe',
    );
    expect(row).toMatchObject({type: 'object', count: 1234});

    let selfSize = 0;
    snapshot.nodes.forEach(node => {
      if (node.type === 'object' && node.name === 'MemlabClassHistogramProbe') {
        selfSize += node.self_size;
      }
    });
    expect(row?.selfSize).toBe(selfSize);

    const counted = histogram.rows.reduce((sum, r) => sum + r.count, 0);
    expect(counted).toBe(histogram.totalCount);
    // every node but the synthetic roots
    expect(histogram.totalCount).toBeGreaterThan(snapshot.nodes.length - 4);
  },
  timeout,
);

test('groups value-named nodes and per-instance scope names', () => {
  expect(getClassKey({type: 'string', name: 'hello'})).toEqual({
    type: 'string',
    name: '(string)',
  });
  expect(getClassKey({type: 'sliced string', name: 'ell'})).toEqual({
    type: 'sliced string',
    name: '(sliced string)',
  });
  expect(getClassKey({type: 'regexp', name: '^a+$'})).toEqual({
    type: 'regexp',
    name: '(regexp)',
  });
  expect(
    getClassKey({type: 'hidden', name: 'system / Context / scope @12345'}),
  ).toEqual({type: 'hidden', name: 'system / Context / scope'});
  expect(getClassKey({type: 'closure', name: ''})).toEqual({
    type: 'closure',
    name: '(closure)',
  });
  expect(getClassKey({type: 'object', name: 'Map'})).toEqual({
    type: 'object',
    name: 'Map',
  });
});

test('sorts by self size and skips the synthetic roots', () => {
  const histogram = buildClassHistogram(
    fakeSnapshot([
      {id: 1, type: 'synthetic', name: '', self_size: 0},
      {id: 3, type: 'synthetic', name: '(GC roots)', self_size: 0},
      {id: 5, type: 'object', name: 'Small', self_size: 10},
      {id: 7, type: 'object', name: 'Big', self_size: 500},
      {id: 9, type: 'object', name: 'Small', self_size: 10},
      {id: 11, type: 'string', name: 'a', self_size: 20},
      {id: 13, type: 'string', name: 'b', self_size: 20},
      {id: 15, type: 'closure', name: 'Small', self_size: 32},
    ]),
  );
  expect(histogram.rows).toEqual([
    {name: 'Big', type: 'object', count: 1, selfSize: 500},
    {name: '(string)', type: 'string', count: 2, selfSize: 40},
    {name: 'Small', type: 'closure', count: 1, selfSize: 32},
    {name: 'Small', type: 'object', count: 2, selfSize: 20},
  ]);
  expect(histogram.totalCount).toBe(6);
  expect(histogram.totalSelfSize).toBe(592);
});

test('filters by class name pattern', () => {
  const histogram = buildClassHistogram(
    fakeSnapshot([
      {id: 5, type: 'native', name: 'Detached HTMLDivElement', self_size: 8},
      {id: 7, type: 'native', name: 'HTMLDivElement', self_size: 8},
      {id: 9, type: 'object', name: 'Detached', self_size: 4},
    ]),
    {namePattern: parseNamePattern('^detached')},
  );
  expect(histogram.rows.map(r => r.name)).toEqual([
    'Detached HTMLDivElement',
    'Detached',
  ]);
  expect(histogram.totalCount).toBe(2);
});

test('treats an invalid regular expression as plain text', () => {
  const pattern = parseNamePattern('Foo(');
  expect(pattern.test('a Foo( b')).toBe(true);
  expect(pattern.test('Foo')).toBe(false);
  expect(parseNamePattern('^fiber').test('FiberNode')).toBe(true);
});
