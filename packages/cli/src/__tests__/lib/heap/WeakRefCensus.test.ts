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
import {censusWeakRefs, isSuspectHolder} from '../../../lib/heap/WeakRefCensus';

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
  smallStale?: Array<{memlabSmallRef: WeakRefLike}>;
  mostlyLive?: Array<{
    memlabMixedRef: WeakRefLike;
    memlabMixedTarget: Target | undefined;
  }>;
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
  // a small holder whose refs are all empty...
  kept.smallStale = Array.from({length: 6}, (_, i) => ({
    memlabSmallRef: new WeakRefCtor({payload: `small gone ${i}`}),
  }));
  // ...and a large one with more empty refs, but mostly live
  kept.mostlyLive = Array.from({length: 200}, (_, i) => {
    const target = {payload: `mixed ${i}`};
    return i < 20
      ? {
          memlabMixedRef: new WeakRefCtor({payload: `mixed gone ${i}`}),
          memlabMixedTarget: undefined,
        }
      : {memlabMixedRef: new WeakRefCtor(target), memlabMixedTarget: target};
  });
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

test('counts instances only, suspects first, then the most empty', () => {
  const sum = census.holders.reduce((n, h) => n + h.total, 0);
  expect(sum).toBe(census.total);
  expect(census.total).toBeGreaterThanOrEqual(306);
  expect(census.empty).toBeGreaterThanOrEqual(96);
  const firstNonSuspect = census.holders.findIndex(h => !h.suspect);
  expect(census.holders.slice(firstNonSuspect).some(h => h.suspect)).toBe(
    false,
  );
  for (const group of [
    census.holders.slice(0, firstNonSuspect),
    census.holders.slice(firstNonSuspect),
  ]) {
    const empties = group.map(h => h.empty);
    expect(empties).toEqual([...empties].sort((a, b) => b - a));
  }
});

test('flags mostly empty holders, and lists them before larger ones', () => {
  const small = census.holders.find(h => h.holder === '{memlabSmallRef}');
  const mostlyLive = census.holders.find(
    h => h.holder === '{memlabMixedRef, memlabMixedTarget}',
  );
  expect(small).toMatchObject({total: 6, empty: 6, suspect: true});
  // more empty refs than the small holder, but 90% live
  expect(mostlyLive).toMatchObject({total: 200, empty: 20, suspect: false});
  const index = (holder: string) =>
    census.holders.findIndex(h => h.holder === holder);
  expect(index('{memlabSmallRef}')).toBeLessThan(
    index('{memlabMixedRef, memlabMixedTarget}'),
  );
});

test('needs more than half empty and at least 5 WeakRefs to suspect', () => {
  expect(isSuspectHolder({total: 5, empty: 3})).toBe(true);
  expect(isSuspectHolder({total: 4, empty: 4})).toBe(false);
  expect(isSuspectHolder({total: 10, empty: 5})).toBe(false);
  expect(isSuspectHolder({total: 10, empty: 6})).toBe(true);
  expect(isSuspectHolder({total: 1000, empty: 100})).toBe(false);
});
