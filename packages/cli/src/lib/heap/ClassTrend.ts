/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {ClassHistogram, ClassKey} from './ClassHistogram';

/**
 * - `grows`: present in the first snapshot, and the count went up between
 *   every pair of consecutive snapshots
 * - `appeared`: absent from the first snapshot and present in the last; the
 *   first step is the class being created at all, which a one-time load
 *   (a lazily loaded module, a cache filled once) also does
 * - `grew`: the count is higher in the last snapshot, but not at every step
 * - `shrank`: the count is lower in the last snapshot
 * - `flat`: the same count in the first and last snapshot
 */
export type Trend = 'grows' | 'appeared' | 'grew' | 'shrank' | 'flat';

export type ClassTrendRow = ClassKey & {
  /** Object count in each snapshot, in order; 0 where the class is absent. */
  counts: number[];
  /** Total self size in each snapshot, in order. */
  selfSizes: number[];
  countDelta: number;
  selfSizeDelta: number;
  trend: Trend;
};

const TREND_ORDER: Record<Trend, number> = {
  grows: 0,
  appeared: 1,
  grew: 2,
  flat: 3,
  shrank: 4,
};

export function classifyTrend(counts: number[]): Trend {
  const first = counts[0] ?? 0;
  const last = counts[counts.length - 1] ?? 0;
  if (last > first) {
    // 0 means no object of the class: it did not exist yet
    if (first === 0) {
      return 'appeared';
    }
    for (let i = 1; i < counts.length; i++) {
      if (counts[i] <= counts[i - 1]) {
        return 'grew';
      }
    }
    return 'grows';
  }
  return last < first ? 'shrank' : 'flat';
}

/**
 * Per-class counts and self sizes across an ordered series of snapshots.
 * Classes that grew at every step come first, then by self-size growth.
 * A class whose count rises with every repetition of the same interaction
 * is the strongest leak signal a series of snapshots gives.
 */
export function buildClassTrend(histograms: ClassHistogram[]): ClassTrendRow[] {
  const n = histograms.length;
  const rows = new Map<string, ClassTrendRow>();
  histograms.forEach((histogram, step) => {
    for (const r of histogram.rows) {
      const id = `${r.type}\u0000${r.name}`;
      let row = rows.get(id);
      if (row == null) {
        row = {
          name: r.name,
          type: r.type,
          counts: new Array(n).fill(0),
          selfSizes: new Array(n).fill(0),
          countDelta: 0,
          selfSizeDelta: 0,
          trend: 'flat',
        };
        rows.set(id, row);
      }
      row.counts[step] = r.count;
      row.selfSizes[step] = r.selfSize;
    }
  });
  const result = [...rows.values()];
  for (const row of result) {
    row.countDelta = row.counts[n - 1] - row.counts[0];
    row.selfSizeDelta = row.selfSizes[n - 1] - row.selfSizes[0];
    row.trend = classifyTrend(row.counts);
  }
  return result.sort(
    (a, b) =>
      TREND_ORDER[a.trend] - TREND_ORDER[b.trend] ||
      b.selfSizeDelta - a.selfSizeDelta ||
      b.countDelta - a.countDelta ||
      a.name.localeCompare(b.name) ||
      a.type.localeCompare(b.type),
  );
}
