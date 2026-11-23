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
 * Old-space sizing for `bin/memlab-mcp.js`, the same rule `bin/memlab-cli.js`
 * and the plugin's `start.sh` apply: 60% of the RAM the process may use
 * (the cgroup cap when there is one), rounded to a whole GB, at least 8 GB on
 * an uncapped host and at most 48 GB. `MEMLAB_MAX_OLD_SPACE_MB` overrides it.
 */
import fs from 'fs';
import os from 'os';

const DEFAULT_MAX_OLD_SPACE_MB = 8192;
const MAX_OLD_SPACE_RAM_FRACTION = 0.6;
const MAX_OLD_SPACE_CEILING_MB = 49152;
const MAX_OLD_SPACE_MIN_MB = 512;

/** The container's memory cap in MB, or 0 when the process is not capped. */
export function cgroupLimitMB(
  read: (f: string) => string = f => fs.readFileSync(f, 'utf8'),
): number {
  for (const f of [
    '/sys/fs/cgroup/memory.max',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes',
  ]) {
    try {
      const raw = read(f).trim();
      if (raw === 'max') continue;
      const bytes = Number(raw);
      if (
        !Number.isFinite(bytes) ||
        bytes <= 0 ||
        bytes >= Number.MAX_SAFE_INTEGER
      ) {
        continue;
      }
      return Math.round(bytes / (1024 * 1024));
    } catch {
      // Not present on this host or not readable.
    }
  }
  return 0;
}

export function defaultMaxOldSpaceMB(
  totalMB: number = Math.round(os.totalmem() / (1024 * 1024)),
  cgroupMB: number = cgroupLimitMB(),
): number {
  const capped = cgroupMB > 0 && (totalMB <= 0 || cgroupMB < totalMB);
  const memMB = capped ? cgroupMB : totalMB;
  if (!Number.isFinite(memMB) || memMB <= 0) return DEFAULT_MAX_OLD_SPACE_MB;
  const scaled = Math.round((memMB * MAX_OLD_SPACE_RAM_FRACTION) / 1024) * 1024;
  if (capped) {
    const headroom = Math.floor(cgroupMB * MAX_OLD_SPACE_RAM_FRACTION);
    return Math.min(
      MAX_OLD_SPACE_CEILING_MB,
      Math.max(MAX_OLD_SPACE_MIN_MB, Math.min(scaled, headroom)),
    );
  }
  return Math.min(
    MAX_OLD_SPACE_CEILING_MB,
    Math.max(DEFAULT_MAX_OLD_SPACE_MB, scaled),
  );
}

export function resolveMaxOldSpaceMB(
  raw: string | undefined = process.env.MEMLAB_MAX_OLD_SPACE_MB,
): number {
  if (raw == null || raw === '') return defaultMaxOldSpaceMB();
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MAX_OLD_SPACE_MIN_MB) {
    throw new Error(
      `MEMLAB_MAX_OLD_SPACE_MB must be a number of MB >= ${MAX_OLD_SPACE_MIN_MB}, got: ${raw}`,
    );
  }
  return Math.round(n);
}

/** Whether the heap limit was already chosen on the command line or in NODE_OPTIONS. */
export function heapLimitIsSet(
  execArgv: readonly string[],
  nodeOptions: string | undefined,
): boolean {
  const re = /^--max[-_]old[-_]space[-_]size(=|$)/;
  return (
    execArgv.some(a => re.test(a)) ||
    (nodeOptions ?? '').split(/\s+/).some(a => re.test(a))
  );
}
