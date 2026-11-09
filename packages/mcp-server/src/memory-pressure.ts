/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * A one-line warning on tool results as the server's own heap fills up.
 *
 * The load guard evicts cold snapshots before a load that would not fit, but
 * nothing warned while analysis itself filled the heap: a 5.3M-node rung plus
 * two dozen rungs held for reuse ran within a few percent of the limit, and an
 * out-of-memory crash there loses every resident snapshot and the session.
 * The highest threshold crossed is announced once on the way up, so a healthy
 * session never pays for the line. A jump past several thresholds at once
 * announces only the highest: the lower notices would say the same thing with
 * less urgency.
 */

import v8 from 'v8';
import {listSnapshots} from './heap-state.js';

const LEVELS = [0.95, 0.85, 0.75];
let announced = 0;

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024)).toLocaleString('en-US')} MB`;
}

export function memoryPressureNotice(): string | null {
  let used: number;
  let limit: number;
  try {
    const s = v8.getHeapStatistics();
    used = s.used_heap_size;
    limit = s.heap_size_limit;
  } catch {
    return null;
  }
  if (!(limit > 0)) return null;
  const fraction = used / limit;
  const level = LEVELS.find(l => fraction >= l) ?? 0;
  if (level <= announced) {
    announced = Math.min(announced, level);
    return null;
  }
  announced = level;
  return (
    `> ⚠️ **Server memory ${Math.round(fraction * 100)}% used**: ${mb(used)} of the ${mb(limit)} heap limit, ` +
    `RSS ${mb(process.memoryUsage().rss)}, ${listSnapshots().length} snapshot(s) resident. ` +
    'An out-of-memory crash loses every resident snapshot and the session. ' +
    'Unload what you are done with: `memlab_snapshots({action: "unload", handle: "…"})`.'
  );
}
