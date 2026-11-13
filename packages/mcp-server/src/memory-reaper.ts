/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {evictLeastRecentlyUsed, unloadIdleSnapshots} from './heap-state.js';

/**
 * Keeps a long-lived server from holding memory nobody is using.
 *
 * - Resident snapshots untouched for `MEMLAB_IDLE_UNLOAD_MIN` minutes
 *   (default 30; 0 turns it off) are unloaded, except the current one.
 * - Above `MEMLAB_RSS_SOFT_CAP_MB` (unset by default), least-recently-used
 *   snapshots are evicted until RSS is under it or only the current one is
 *   left.
 *
 * Checked once a minute on an unref'd timer, so it never keeps the process
 * alive. What it did is kept for `memlab_server_status`.
 */

export interface ReaperEvent {
  at: number;
  reason: 'idle' | 'rss-cap';
  handle: string;
  file: string;
}

const events: ReaperEvent[] = [];
let started = false;

export function reaperEvents(): readonly ReaperEvent[] {
  return events;
}

export function reaperSettings(): {idleMin: number; rssCapMb: number | null} {
  const idle = Number(process.env.MEMLAB_IDLE_UNLOAD_MIN ?? 30);
  const cap = Number(process.env.MEMLAB_RSS_SOFT_CAP_MB);
  return {
    idleMin: Number.isFinite(idle) && idle >= 0 ? idle : 30,
    rssCapMb: Number.isFinite(cap) && cap > 0 ? cap : null,
  };
}

function record(reason: ReaperEvent['reason'], handle: string, file: string) {
  events.push({at: Date.now(), reason, handle, file});
  if (events.length > 50) events.shift();
  process.stderr.write(
    `[memlab] unloaded ${handle} (${file}): ${reason === 'idle' ? 'idle' : 'RSS over the soft cap'}\n`,
  );
}

/** One pass; exported for tests. */
export function reapOnce(now = Date.now()): void {
  const {idleMin, rssCapMb} = reaperSettings();
  if (idleMin > 0) {
    for (const m of unloadIdleSnapshots(idleMin * 60_000, now)) {
      record('idle', m.handle, m.fileName);
    }
  }
  if (rssCapMb != null) {
    while (process.memoryUsage().rss / 1048576 > rssCapMb) {
      const m = evictLeastRecentlyUsed();
      if (m == null) break;
      record('rss-cap', m.handle, m.fileName);
    }
  }
}

export function startMemoryReaper(): void {
  if (started) return;
  started = true;
  setInterval(() => reapOnce(), 60_000).unref();
}
