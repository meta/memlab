/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {WeakRefCensus} from '../../../lib/heap/WeakRefCensus';

import {config, dumpNodeHeapSnapshot, utils} from '@memlab/core';
import {censusWeakRefs} from '../../../lib/heap/WeakRefCensus';

const timeout = 5 * 60 * 1000;

type Target = {payload: string};
// the package's TypeScript lib predates WeakRef
type WeakRefLike = {deref(): Target | undefined};
const WeakRefCtor = (
  globalThis as unknown as {WeakRef: new (target: Target) => WeakRefLike}
).WeakRef;

// retained until the snapshot is taken
const kept: {
  live?: Array<{memlabLiveRef: WeakRefLike; memlabTarget: Target}>;
  stale?: Array<{memlabStaleRef: WeakRefLike; memlabRecord: string}>;
} = {};
let census: WeakRefCensus;

beforeAll(async () => {
  config.isTest = true;
  kept.live = Array.from({length: 30}, (_, i) => {
    const target = {payload: `live ${i}`};
    return {memlabLiveRef: new WeakRefCtor(target), memlabTarget: target};
  });
  kept.stale = Array.from({length: 70}, (_, i) => ({
    memlabStaleRef: new WeakRefCtor({payload: `gone ${i}`}),
    memlabRecord: `record ${i}`,
  }));
  // A WeakRef keeps its target alive until the current job ends, so the
  // targets of the stale refs can only be collected after this yields.
  await new Promise(resolve => setTimeout(resolve, 10));
  const snapshot = await utils.getSnapshotFromFile(dumpNodeHeapSnapshot(), {});
  census = censusWeakRefs(snapshot);
}, timeout);

test('splits WeakRefs held by one shape into live and empty', () => {
  const live = census.holders.find(
    h => h.holder === '{memlabLiveRef, memlabTarget}',
  );
  const stale = census.holders.find(
    h => h.holder === '{memlabRecord, memlabStaleRef}',
  );
  expect(live).toMatchObject({total: 30, empty: 0});
  expect(stale).toMatchObject({total: 70, empty: 70});
  expect(stale?.exampleId).toBeGreaterThan(3);
});

test('counts instances only, with the most empty holders first', () => {
  const sum = census.holders.reduce((n, h) => n + h.total, 0);
  expect(sum).toBe(census.total);
  expect(census.total).toBeGreaterThanOrEqual(100);
  expect(census.empty).toBeGreaterThanOrEqual(70);
  const empties = census.holders.map(h => h.empty);
  expect(empties).toEqual([...empties].sort((a, b) => b - a));
});
