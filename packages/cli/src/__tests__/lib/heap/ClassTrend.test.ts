/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {ClassHistogram} from '../../../lib/heap/ClassHistogram';

import {config, dumpNodeHeapSnapshot, utils} from '@memlab/core';
import {buildClassHistogram} from '../../../lib/heap/ClassHistogram';
import {buildClassTrend, classifyTrend} from '../../../lib/heap/ClassTrend';

const timeout = 5 * 60 * 1000;

beforeEach(() => {
  config.isTest = true;
});

function histogram(rows: Array<[string, number, number]>): ClassHistogram {
  return {
    rows: rows.map(([name, count, selfSize]) => ({
      name,
      type: 'object',
      count,
      selfSize,
    })),
    totalCount: rows.reduce((sum, r) => sum + r[1], 0),
    totalSelfSize: rows.reduce((sum, r) => sum + r[2], 0),
  };
}

class MemlabClassTrendProbe {
  constructor(public label: string) {}
}

test('classifies a series of counts', () => {
  expect(classifyTrend([1, 2, 3])).toBe('grows');
  expect(classifyTrend([1, 3, 2])).toBe('grew');
  expect(classifyTrend([1, 1, 2])).toBe('grew');
  expect(classifyTrend([3, 1, 2])).toBe('shrank');
  expect(classifyTrend([2, 5, 2])).toBe('flat');
  // absent at first: created during the series, not grown at every step
  expect(classifyTrend([0, 4])).toBe('appeared');
  expect(classifyTrend([0, 10, 20, 30])).toBe('appeared');
  expect(classifyTrend([0, 0, 7])).toBe('appeared');
  expect(classifyTrend([1, 10, 20, 30])).toBe('grows');
  expect(classifyTrend([0, 0, 0])).toBe('flat');
});

test('lines classes up across snapshots, steadily growing first', () => {
  const rows = buildClassTrend([
    histogram([
      ['Steady', 10, 100],
      ['Bumpy', 10, 100],
      ['Gone', 5, 50],
      ['Flat', 3, 30],
    ]),
    histogram([
      ['Steady', 20, 200],
      ['Bumpy', 40, 400],
      ['Flat', 3, 30],
    ]),
    histogram([
      ['Steady', 30, 300],
      ['Bumpy', 35, 350],
      ['Flat', 3, 30],
      ['Late', 7, 70],
    ]),
  ]);
  expect(rows.map(r => [r.name, r.trend, r.counts])).toEqual([
    ['Steady', 'grows', [10, 20, 30]],
    // absent from the first two snapshots
    ['Late', 'appeared', [0, 0, 7]],
    ['Bumpy', 'grew', [10, 40, 35]],
    ['Flat', 'flat', [3, 3, 3]],
    ['Gone', 'shrank', [5, 0, 0]],
  ]);
  expect(rows[0]).toMatchObject({countDelta: 20, selfSizeDelta: 200});
  expect(rows.find(r => r.name === 'Gone')).toMatchObject({
    countDelta: -5,
    selfSizes: [50, 0, 0],
  });
});

test(
  'finds a class that grows with every snapshot of a real heap',
  async () => {
    const probes: MemlabClassTrendProbe[] = [];
    const histograms: ClassHistogram[] = [];
    for (let step = 1; step <= 3; step++) {
      for (let i = 0; i < 100; i++) {
        probes.push(new MemlabClassTrendProbe(`step ${step} #${i}`));
      }
      const snapshot = await utils.getSnapshotFromFile(
        dumpNodeHeapSnapshot(),
        {},
      );
      histograms.push(buildClassHistogram(snapshot));
    }
    expect(probes.length).toBe(300);
    const row = buildClassTrend(histograms).find(
      r => r.name === 'MemlabClassTrendProbe' && r.type === 'object',
    );
    expect(row).toMatchObject({
      trend: 'grows',
      counts: [100, 200, 300],
      countDelta: 200,
    });
  },
  timeout,
);
