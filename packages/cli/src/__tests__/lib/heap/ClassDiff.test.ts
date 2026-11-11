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
import type {ClassHistogram} from '../../../lib/heap/ClassHistogram';

import childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {config, dumpNodeHeapSnapshot, NumericSet, utils} from '@memlab/core';
import {buildClassHistogram} from '../../../lib/heap/ClassHistogram';
import {
  addNewObjectCounts,
  collectStableIds,
  compareHeapIdentity,
  diffClassHistograms,
  sampleNodes,
} from '../../../lib/heap/ClassDiff';

const timeout = 5 * 60 * 1000;

beforeEach(() => {
  config.isTest = true;
});

function histogram(
  rows: Array<[string, string, number, number]>,
): ClassHistogram {
  return {
    rows: rows.map(([name, type, count, selfSize]) => ({
      name,
      type,
      count,
      selfSize,
    })),
    totalCount: rows.reduce((sum, r) => sum + r[2], 0),
    totalSelfSize: rows.reduce((sum, r) => sum + r[3], 0),
  };
}

type FakeNode = Pick<IHeapNode, 'id' | 'type' | 'name' | 'self_size'>;

function fakeSnapshot(nodes: FakeNode[]): IHeapSnapshot {
  return {
    nodes: {
      length: nodes.length,
      forEach: (callback: (node: IHeapNode, index: number) => void) =>
        nodes.forEach((node, i) => callback(node as IHeapNode, i)),
    },
  } as unknown as IHeapSnapshot;
}

class MemlabClassDiffProbe {
  constructor(public label: string) {}
}

test('diffs per class, largest self-size growth first', () => {
  const rows = diffClassHistograms(
    histogram([
      ['Kept', 'object', 10, 100],
      ['Shrunk', 'object', 5, 500],
      ['Gone', 'closure', 2, 64],
    ]),
    histogram([
      ['Kept', 'object', 10, 100],
      ['Shrunk', 'object', 1, 100],
      ['Grew', 'object', 30, 900],
      ['New', 'object', 3, 30],
    ]),
  );
  expect(rows.map(r => [r.name, r.countDelta, r.selfSizeDelta])).toEqual([
    ['Grew', 30, 900],
    ['New', 3, 30],
    ['Kept', 0, 0],
    ['Gone', -2, -64],
    ['Shrunk', -4, -400],
  ]);
  expect(rows.find(r => r.name === 'Gone')).toMatchObject({
    baselineCount: 2,
    targetCount: 0,
    baselineSelfSize: 64,
    targetSelfSize: 0,
  });
});

test('keeps classes of the same name and different types apart', () => {
  const rows = diffClassHistograms(
    histogram([['Foo', 'object', 1, 10]]),
    histogram([
      ['Foo', 'object', 1, 10],
      ['Foo', 'closure', 4, 128],
    ]),
  );
  expect(rows.map(r => [r.name, r.type, r.countDelta])).toEqual([
    ['Foo', 'closure', 4],
    ['Foo', 'object', 0],
  ]);
});

test('counts new objects per class and leaves native classes uncounted', () => {
  const baseline = fakeSnapshot([
    {id: 5, type: 'object', name: 'Foo', self_size: 8},
    {id: 7, type: 'native', name: 'Node', self_size: 8},
  ]);
  const target = fakeSnapshot([
    {id: 5, type: 'object', name: 'Foo', self_size: 8},
    {id: 9, type: 'object', name: 'Foo', self_size: 8},
    {id: 11, type: 'object', name: 'Foo', self_size: 8},
    {id: 13, type: 'native', name: 'Node', self_size: 8},
  ]);
  const rows = diffClassHistograms(
    buildClassHistogram(baseline),
    buildClassHistogram(target),
  );
  addNewObjectCounts(rows, target, collectStableIds(baseline));
  expect(rows.find(r => r.name === 'Foo')).toMatchObject({
    countDelta: 2,
    newCount: 2,
    newSelfSize: 16,
  });
  expect(rows.find(r => r.name === 'Node')?.newCount).toBeUndefined();
});

test('needs enough surviving ids before calling two snapshots one heap', () => {
  const sample = Array.from({length: 100}, (_, i) => ({
    id: 5 + i * 2,
    type: 'object',
    name: 'Foo',
  }));
  const sameObjects = {
    getNodeById: (id: number) => ({id, type: 'object', name: 'Foo'}),
  } as unknown as IHeapSnapshot;
  // 100 matches are fewer than the 200 required
  expect(compareHeapIdentity(sample, sameObjects)).toMatchObject({
    sameHeap: false,
    found: 100,
    matched: 100,
  });
});

test(
  'tells snapshots of one heap from snapshots of another',
  async () => {
    const probes = Array.from(
      {length: 200},
      (_, i) => new MemlabClassDiffProbe(`before ${i}`),
    );
    const baselineFile = dumpNodeHeapSnapshot();
    for (let i = 0; i < 300; i++) {
      probes.push(new MemlabClassDiffProbe(`after ${i}`));
    }
    const targetFile = dumpNodeHeapSnapshot();
    expect(probes.length).toBe(500);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlab-class-diff-'));
    const otherFile = path.join(tmpDir, 'other.heapsnapshot');
    childProcess.execFileSync(process.execPath, [
      '-e',
      `require('v8').writeHeapSnapshot(${JSON.stringify(otherFile)})`,
    ]);

    try {
      const baseline = await utils.getSnapshotFromFile(baselineFile, {});
      const baselineHistogram = buildClassHistogram(baseline);
      const baselineIds: NumericSet = collectStableIds(baseline);
      const sample = sampleNodes(baseline);

      const target = await utils.getSnapshotFromFile(targetFile, {});
      expect(compareHeapIdentity(sample, target).sameHeap).toBe(true);
      const rows = diffClassHistograms(
        baselineHistogram,
        buildClassHistogram(target),
      );
      addNewObjectCounts(rows, target, baselineIds);
      expect(
        rows.find(
          r => r.name === 'MemlabClassDiffProbe' && r.type === 'object',
        ),
      ).toMatchObject({
        baselineCount: 200,
        targetCount: 500,
        countDelta: 300,
        newCount: 300,
      });

      const other = await utils.getSnapshotFromFile(otherFile, {});
      expect(compareHeapIdentity(sample, other).sameHeap).toBe(false);
    } finally {
      fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  },
  timeout,
);
