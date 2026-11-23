/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import fs from 'fs';
import {z} from 'zod';
import {
  listSnapshots,
  resolveHandle,
  runWithBorrowedHandle,
} from './heap-state.js';
import {noteRungCached, withSnapshotAt} from './snapshot-borrow.js';
import {resolveSnapshotPath} from './tools/load-snapshot.js';

/**
 * Stateless addressing: every single-snapshot tool takes an optional
 * `snapshot`, a resident handle or a `.heapsnapshot` path, and runs against it
 * without moving the session's active snapshot.
 *
 * Without it, a tool always reads the ACTIVE snapshot, so comparing two
 * captures meant `memlab_snapshots({action: "switch"})` between calls — and
 * forgetting one switch silently answered the question about the wrong
 * capture, with node ids that do not exist in the one meant.
 */

/** Tools that take several snapshots or manage the session themselves. */
const MULTI_SNAPSHOT_KEYS = [
  'paths',
  'run_dir',
  'before',
  'after',
  'baseline',
  'target',
  'baseline_handle',
  'target_handle',
  'handles',
  'file_path',
  'ladder',
  'snapshot',
];
const SESSION_TOOLS = new Set([
  'memlab_snapshots',
  'memlab_server_status',
  'memlab_tools',
  'memlab_job_status',
  'memlab_batch',
  'memlab_start_job',
  'memlab_coverage_check',
]);

/**
 * Single-snapshot tools that also have an OPTIONAL multi-snapshot mode: a
 * `baseline` to compare against, or a ladder through `run_dir` / `paths`.
 * Without those they read the active snapshot like any other tool, so they
 * take `snapshot` too. `memlab_detached_dom` refused it in 8 of 18 calls in
 * one study, each time right after a sibling tool had accepted it.
 */
const OPTIONAL_MULTI_SNAPSHOT_TOOLS = new Set([
  'memlab_detached_dom',
  'memlab_sweep',
]);

/** Keys that make one of those tools read other snapshots instead. */
const LADDER_KEYS = ['run_dir', 'paths'];

export function takesSnapshotParam(
  name: string,
  shape: Record<string, unknown>,
): boolean {
  if (SESSION_TOOLS.has(name)) return false;
  if (OPTIONAL_MULTI_SNAPSHOT_TOOLS.has(name)) return true;
  return !MULTI_SNAPSHOT_KEYS.some(k => k in shape);
}

/**
 * Why `snapshot` cannot apply to this call, or `null` when it can: a ladder
 * reads its own rungs, so a `snapshot` next to `run_dir` / `paths` would be
 * silently ignored.
 */
export function snapshotRefConflict(params: object): string | null {
  const set = LADDER_KEYS.filter(k => {
    const v = (params as Record<string, unknown>)[k];
    return v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
  });
  if (set.length === 0) return null;
  return `\`snapshot\` picks the one snapshot this call reads, and \`${set.join('` / `')}\` makes it read a ladder instead. Pass one or the other.`;
}

export function snapshotParam() {
  return z
    .string()
    .optional()
    .describe(
      'Run against this snapshot instead of the active one: a resident handle, or a .heapsnapshot path (parsed once and kept in the session rung cache, so the next call on the same path reuses it). The active snapshot is not changed.',
    );
}

/** Run `fn` with `ref` as the active snapshot, then restore the session. */
export async function withSnapshotRef<T>(
  ref: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  // A readable file goes by path, so the rewritten-file check applies and a
  // resident snapshot that only shares its basename is not borrowed.
  const handle = fs.existsSync(ref) ? null : resolveHandle(ref);
  if (handle != null) {
    if (/\.heapsnapshot(\.gz)?$/.test(ref)) noteRungCached();
    return await runWithBorrowedHandle(handle, fn);
  }
  const {localPath} = resolveSnapshotPath(ref);
  if (!fs.existsSync(localPath)) {
    const handles = listSnapshots().map(m => m.handle);
    throw new Error(
      `\`snapshot: "${ref}"\` is neither a resident handle` +
        (handles.length > 0 ? ` (${handles.join(', ')})` : '') +
        ' nor a readable .heapsnapshot path.',
    );
  }
  return withSnapshotAt(localPath, () => fn());
}
