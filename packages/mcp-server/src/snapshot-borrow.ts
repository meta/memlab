/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {timedLoad} from './perf-stats.js';
import {currentProgress} from './progress.js';
import {releaseMemory} from './memory-release.js';
import {detectEnv} from './tools/load-snapshot.js';
import type {IHeapSnapshot} from '@memlab/core';
import {AsyncLocalStorage} from 'node:async_hooks';
import fs from 'fs';
import os from 'os';
import memlabHeapAnalysis from '@memlab/heap-analysis';
const {getFullHeapFromFile} = memlabHeapAnalysis;
import {
  findResidentByPath,
  pinHandle,
  getMetadataByHandle,
  resolveHandle,
  getSnapshotByHandle,
  removeSnapshot,
  getSessionHandle,
  isPinned,
  restoreCurrentHandle,
  runWithBorrowedHandle,
  unpinHandle,
  setSnapshot,
  isCachedHandle,
  setCachedHandle,
  statOrNull,
} from './heap-state.js';
import {beginAnalysisBudget} from './analysis-budget.js';
import {
  estimateLoadHeapMB,
  fileSizeRefusal,
  getHeapHeadroomMB,
  resolveSnapshotPath,
} from './tools/load-snapshot.js';
import {noteSnapshotRead} from './read-scope.js';

/**
 * Rungs borrowed inside a retention scope stay resident after the borrow, so
 * the next tool that walks the same ladder reuses them instead of re-parsing.
 * A battery ran 6+ ladder tools over the same 5 rungs, and each one parsed
 * every rung again: about 30 parses of 400-500 MB files per round.
 */
interface RungRetention {
  /** Retained handles, least recently borrowed first. */
  handles: string[];
  parses: number;
  reuses: number;
  evicted: number;
  cap: () => number;
}

const retentionStore = new AsyncLocalStorage<RungRetention>();

function capFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw == null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** MEMLAB_RETAIN_RUNGS caps how many rungs a scope keeps (0 disables). */
function retainCap(): number {
  return capFromEnv('MEMLAB_RETAIN_RUNGS', 8);
}

/**
 * Rungs kept parsed between calls, for every caller with no scope of its
 * own. Interactive ladder calls used to parse every rung on every call (a
 * `ladder_probe` per metric re-read the same five rungs), while only the
 * battery kept them. Bounded by `MEMLAB_SESSION_RUNGS` (0 disables) and by
 * the free heap, and dropped by the idle unloader like any resident snapshot.
 */
const sessionRetention: RungRetention = {
  handles: [],
  parses: 0,
  reuses: 0,
  evicted: 0,
  cap: () => capFromEnv('MEMLAB_SESSION_RUNGS', 6),
};

interface RungCallStats {
  parsed: number;
  cached: number;
}
const rungStatsStore = new AsyncLocalStorage<RungCallStats>();

/** Count a rung read from memory by a path outside `withSnapshotAt`. */
export function noteRungCached(): void {
  const stats = rungStatsStore.getStore();
  if (stats != null) stats.cached++;
}

/** Count the rungs `fn` borrows: parsed for it, or already resident. */
export async function runWithRungStats<T>(
  fn: () => Promise<T>,
): Promise<{result: T; stats: RungCallStats}> {
  const stats: RungCallStats = {parsed: 0, cached: 0};
  const result = await rungStatsStore.run(stats, fn);
  return {result, stats};
}

/**
 * Room to load and analyse one more rung of this size, in old space and in
 * system memory (the graph's typed arrays live outside the V8 heap).
 */
function roomForAnother(snapshot: IHeapSnapshot): boolean {
  const needMB =
    2 *
    estimateLoadHeapMB(
      {
        nodeCount: snapshot.nodes?.length ?? 0,
        edgeCount: snapshot.edges?.length ?? 0,
      },
      false,
    );
  const heap = getHeapHeadroomMB();
  const freeMB = os.freemem() / (1024 * 1024);
  return (heap == null || heap >= needMB) && freeMB >= needMB;
}

export interface RungRetentionStats {
  parses: number;
  reuses: number;
  evicted: number;
}

/**
 * Run `fn` with borrowed rungs kept resident, within memory, until it ends.
 * The rungs still retained then pass to the session cache, which keeps as
 * many as its cap and the free heap allow.
 */
export async function runWithRungRetention<T>(
  fn: () => Promise<T>,
): Promise<{result: T; stats: RungRetentionStats}> {
  const r: RungRetention = {
    handles: [],
    parses: 0,
    reuses: 0,
    evicted: 0,
    cap: retainCap,
  };
  try {
    const result = await retentionStore.run(r, fn);
    return {
      result,
      stats: {parses: r.parses, reuses: r.reuses, evicted: r.evicted},
    };
  } finally {
    const current = getSessionHandle();
    let dropped = 0;
    // Handed to the session cache, so the calls after the battery reuse what
    // it parsed.
    for (const h of r.handles) {
      if (h === current) continue;
      const snap = getSnapshotByHandle(h);
      if (snap != null && retain(sessionRetention, h, snap, current)) continue;
      // A pinned rung is in use by a call still running.
      if (h !== current && !isPinned(h) && removeSnapshot(h)) dropped++;
    }
    r.handles.length = 0;
    if (dropped > 0) releaseMemory(1);
  }
}

/**
 * Keep a just-borrowed rung, evicting the oldest kept ones to make room.
 * `callerHandle` (the snapshot active before the borrow) is never evicted:
 * if it is a kept rung, the caller now owns it and it leaves the scope. A rung
 * another call has pinned, `handle` included, stays kept and is evicted later.
 */
function retain(
  r: RungRetention,
  handle: string,
  snapshot: IHeapSnapshot,
  callerHandle: string | null,
): boolean {
  const cap = r.cap();
  if (cap === 0) return false;
  const session = r === sessionRetention;
  // A replacing load elsewhere may have dropped kept rungs already, and a
  // cached rung the user has since loaded is theirs, not the cache's.
  r.handles = r.handles.filter(
    h =>
      h !== handle &&
      getMetadataByHandle(h) != null &&
      (!session || isCachedHandle(h)),
  );
  r.handles.push(handle);
  if (session) setCachedHandle(handle, true);
  const pinnedVictims: string[] = [];
  while (
    r.handles.length > 0 &&
    (r.handles.length > cap || !roomForAnother(snapshot))
  ) {
    const victim = r.handles.shift() as string;
    if (victim === callerHandle || victim === getSessionHandle()) {
      if (session) setCachedHandle(victim, false);
      continue;
    }
    if (isPinned(victim)) {
      pinnedVictims.push(victim);
      continue;
    }
    removeSnapshot(victim);
    r.evicted++;
    releaseMemory(1);
    if (victim === handle) break;
  }
  r.handles.unshift(...pinnedVictims);
  return true;
}

/**
 * Load a rung that may have been compressed since it was resolved.
 *
 * Ladder tools resolve every rung up front (`resolveRungs`) and load them one
 * by one over minutes. A sweep compressing an analyzed round meanwhile
 * (`memlab_prune_run`) replaces `<rung>` with `<rung>.gz`, and the later load
 * of the plain path failed with ENOENT. The rung is then re-resolved, which
 * decompresses the archive, and loaded from there.
 */
async function loadFollowingCompression(
  localPath: string,
): Promise<IHeapSnapshot> {
  const viaArchive = () =>
    getFullHeapFromFile(resolveSnapshotPath(localPath).localPath);
  if (!fs.existsSync(localPath) && fs.existsSync(`${localPath}.gz`)) {
    return viaArchive();
  }
  try {
    return await getFullHeapFromFile(localPath);
  } catch (err) {
    // Compressed between the check and the open.
    const e = err as NodeJS.ErrnoException | null;
    if (
      (e?.code === 'ENOENT' || /ENOENT/.test(String(e?.message))) &&
      fs.existsSync(`${localPath}.gz`)
    ) {
      return viaArchive();
    }
    throw err;
  }
}

/**
 * Run `fn` against the snapshot at `localPath`, loading it only if it is not
 * already resident, and leaving the session exactly as it was found.
 *
 * Every tool that walks an ORDERED ladder needs this, and each one getting it
 * subtly wrong is the failure mode worth designing out. Three invariants:
 *
 *  - **Reuse a resident graph.** Re-parsing a 250 MB capture that is already in
 *    memory is the single most expensive avoidable thing these tools do.
 *  - **Hold one graph at a time.** `memlab_eval_across` needs every rung
 *    resident simultaneously, which is precisely why it cannot serve a ladder of
 *    large captures. Loading and dropping keeps peak RSS at one rung.
 *  - **Restore the caller's active snapshot.** A ladder walk is a measurement,
 *    not a navigation; silently leaving the session pointed at rung 6 makes the
 *    caller's next `memlab_eval` answer a question about the wrong capture, and
 *    nothing in that output says so.
 */
export async function withSnapshotAt<T>(
  localPath: string,
  fn: (snapshot: IHeapSnapshot) => Promise<T> | T,
): Promise<T> {
  const resident = findResidentByPath(localPath);
  let snapshot: IHeapSnapshot | null =
    resident != null ? getSnapshotByHandle(resident.handle) : null;
  const stats = rungStatsStore.getStore();
  if (stats != null) {
    if (snapshot != null) stats.cached++;
    else stats.parsed++;
  }
  // The SESSION's handle, not this context's: a borrow is never restored to
  // another borrow's rung, which is unloaded when that borrow ends.
  const previousHandle = getSessionHandle();
  let temporaryHandle: string | null = null;
  pinHandle(previousHandle);
  // Before the parse: a rewrite during it must not look like the parsed file.
  const fileStat = resident == null ? statOrNull(localPath) : null;

  const retention = retentionStore.getStore() ?? sessionRetention;
  if (
    retention != null &&
    resident != null &&
    retention.handles.includes(resident.handle)
  ) {
    retention.reuses++;
    // Most recently borrowed last, so eviction takes the coldest rung.
    retention.handles = [
      ...retention.handles.filter(h => h !== resident.handle),
      resident.handle,
    ];
  }
  try {
    if (snapshot == null) {
      if (retention != null) retention.parses++;
      const name = localPath.replace(/^.*\//, '');
      const started = Date.now();
      currentProgress().note?.(
        `loading ${name} (the parse and dominator pass block without further output)`,
      );
      snapshot = await timedLoad(localPath, 'temporary', () =>
        loadFollowingCompression(localPath),
      );
      currentProgress().note?.(
        `loaded ${name} in ${Math.round((Date.now() - started) / 1000)}s`,
      );
      const meta = setSnapshot(
        snapshot,
        localPath,
        {
          fileName: localPath.replace(/^.*\//, ''),
          nodeCount: snapshot.nodes?.length ?? 0,
          edgeCount: snapshot.edges?.length ?? 0,
          // Node 0 is V8's synthetic root: it dominates every node, so its
          // retained size is the heap total.
          totalSize: snapshot.nodes?.get(0)?.retainedSize ?? 0,
          env: detectEnv(snapshot).env,
          fileStat,
        },
        {replace: false},
      );
      temporaryHandle = meta.handle;
      // `setSnapshot` made the rung the session's snapshot; it is this
      // call's only.
      restoreCurrentHandle(previousHandle);
    }
    // Only once the rung is loaded: a failed load was not read.
    noteSnapshotRead(localPath);
    const borrowed = temporaryHandle ?? resident?.handle;
    // Never fall back to the session's snapshot: that would answer about
    // the wrong capture without saying so.
    if (borrowed == null) {
      throw new Error(`${localPath} is loaded but has no snapshot handle`);
    }
    const rung = snapshot;
    return await runWithBorrowedHandle(borrowed, () => fn(rung));
  } finally {
    // Retained: removed later by its scope (or evicted for room) instead.
    const kept =
      temporaryHandle != null &&
      retention != null &&
      snapshot != null &&
      retain(retention, temporaryHandle, snapshot, previousHandle);
    if (temporaryHandle != null && !kept) {
      removeSnapshot(temporaryHandle);
      // Ladder tools borrow one rung after another; free each before the next.
      // This frame's own reference has to go first, or the GC keeps the rung.
      snapshot = null;
      releaseMemory(1);
    }
    // Only when the session handle is gone: a load the caller made meanwhile
    // stays active. A fallback is announced in the next result.
    if (previousHandle != null && getMetadataByHandle(previousHandle) == null) {
      restoreCurrentHandle(previousHandle);
    }
    unpinHandle(previousHandle);
  }
}

export interface ResolvedRung {
  /** The path as the caller wrote it, used in report rows. */
  label: string;
  localPath: string;
  sizeMB: number;
}

/**
 * Resolve every path and check its size BEFORE anything is loaded.
 *
 * Ordering matters here: an unreadable or oversized rung five should fail in a
 * second, not after four multi-minute loads have already been paid for.
 */
export function resolveRungs(
  paths: string[],
  maxFileSizeMB?: number,
): {rungs: ResolvedRung[]; largestMB: number} {
  const rungs: ResolvedRung[] = [];
  let largestMB = 0;
  for (const p of paths) {
    // A resident HANDLE is accepted wherever a rung path is: the borrow below
    // then reuses the resident graph by its file path instead of failing with
    // "File not found: <cwd>/<handle>". Only a reference that is not itself a
    // readable file is looked up, so a path always means that file.
    if (!fs.existsSync(p)) {
      let handle: string | null = null;
      try {
        handle = resolveHandle(p);
      } catch {
        // Ambiguous basename: fall through to the path error below.
      }
      const meta = handle != null ? getMetadataByHandle(handle) : null;
      if (meta != null && fs.existsSync(meta.filePath)) {
        const sizeMB = fs.statSync(meta.filePath).size / (1024 * 1024);
        largestMB = Math.max(largestMB, sizeMB);
        rungs.push({label: meta.fileName, localPath: meta.filePath, sizeMB});
        continue;
      }
    }
    const {localPath, fetchedFrom} = resolveSnapshotPath(p);
    if (!fs.existsSync(localPath)) {
      throw new Error(`File not found: ${localPath}`);
    }
    const sizeMB = fs.statSync(localPath).size / (1024 * 1024);
    largestMB = Math.max(largestMB, sizeMB);
    const refusal = fileSizeRefusal(
      p,
      localPath,
      sizeMB,
      maxFileSizeMB,
      fetchedFrom != null,
    );
    if (refusal != null) throw new Error(refusal);
    rungs.push({label: p.replace(/^.*\//, ''), localPath, sizeMB});
  }
  return {rungs, largestMB};
}

/**
 * A full-heap walk on a multi-million-node graph does not finish inside the
 * 60 s eval default, and every caller discovering that by timing out first is
 * pure friction. Scale from the largest rung.
 */
export function scaledTimeoutMs(largestMB: number, explicit?: number): number {
  return explicit ?? Math.max(60000, Math.ceil(largestMB * 600));
}

/**
 * Re-arm the whole-heap scan guardrail for the work about to be done.
 *
 * Scaling a tool's own `timeout_ms` is NOT enough on its own, which is only
 * obvious once you run against a big graph. The guardrail in `guardrail.ts`
 * arms a 90s scan budget from the tool's incoming params before the handler
 * runs; a tool that then computes a larger per-snapshot timeout is still inside
 * that 90s budget, so a full-heap walk dies at 90s no matter what it asked for.
 * Measured on a real 690 MB / 5.1M-node Ads Manager capture: a detached-node
 * probe raised its eval timeout to 414s and still lost the rung to
 * `Scan exceeded its 90000ms budget`.
 *
 * Re-arming per snapshot is what `memlab_analyze_run` already does for its
 * steps. The guardrail's own `finally` disarms afterwards, so nothing leaks.
 */
export function armScanBudgetFor(timeoutMs: number): void {
  beginAnalysisBudget(timeoutMs);
}
