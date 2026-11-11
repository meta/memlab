/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {SlicedStringReport} from '../../../lib/heap/SlicedStrings';

import {config, dumpNodeHeapSnapshot, utils} from '@memlab/core';
import {findSlicedStringParents} from '../../../lib/heap/SlicedStrings';

const timeout = 5 * 60 * 1000;

// retained until the snapshot is taken
const kept: {slices?: string[]; text?: string; textSlices?: string[]} = {};
let report: SlicedStringReport;

function flatString(prefix: string, count: number): string {
  // JSON.stringify returns a flat string, which V8 slices instead of copying
  return JSON.stringify(Array.from({length: count}, (_, i) => `${prefix}${i}`));
}

// Built in its own function so that, once it returns, only the slices
// reference the ~700 KB parent string.
function slicesOfDroppedString(): string[] {
  const parent = flatString('memlab-sliced-parent-', 30000);
  return Array.from({length: 40}, (_, i) =>
    parent.slice(i * 100, i * 100 + 50),
  );
}

beforeAll(async () => {
  config.isTest = true;
  kept.slices = slicesOfDroppedString();
  // this one is also referenced directly
  kept.text = flatString('memlab-kept-parent-', 3000);
  kept.textSlices = [kept.text.slice(5, 40)];
  const snapshot = await utils.getSnapshotFromFile(dumpNodeHeapSnapshot(), {});
  report = findSlicedStringParents(snapshot);
}, timeout);

test('finds the parent that only slices keep alive', () => {
  const parent = report.parents.find(p =>
    p.preview.includes('memlab-sliced-parent-0'),
  );
  expect(parent).toMatchObject({sliceCount: 40, heldOnlyBySlices: true});
  expect(parent?.size).toBeGreaterThan(600000);
  expect(report.pinnedSize).toBeGreaterThanOrEqual(parent?.size ?? 0);
});

test('does not count a parent that is also referenced directly', () => {
  const parent = report.parents.find(p =>
    p.preview.includes('memlab-kept-parent-0'),
  );
  expect(parent).toMatchObject({sliceCount: 1, heldOnlyBySlices: false});
});

test('ranks parents by size and counts every slice once', () => {
  const sizes = report.parents.map(p => p.size);
  expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  const slices = report.parents.reduce((sum, p) => sum + p.sliceCount, 0);
  expect(slices).toBeLessThanOrEqual(report.slicedCount);
  expect(report.slicedCount).toBeGreaterThanOrEqual(41);
});
