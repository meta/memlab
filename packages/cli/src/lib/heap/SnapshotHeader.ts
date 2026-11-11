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
import v8 from 'v8';

export type SnapshotHeader = {
  file: string;
  fileSizeBytes: number;
  nodeCount: number;
  edgeCount: number;
  /** Number of functions in the allocation-stack table; 0 when not recorded. */
  traceFunctionCount: number;
  /** Native memory the snapshot attributes to no node (0 when absent). */
  extraNativeBytes: number;
  nodeFields: string[];
  /** Whether each node records attached/detached state (newer Chromium). */
  hasDetachedness: boolean;
  /** Whether the capture was taken with allocation tracking on. */
  hasAllocationStacks: boolean;
};

const READ_CHUNK_BYTES = 64 * 1024;
// The header precedes the `nodes` array and holds only the metadata and
// counts, so it is a few KB. The cap only bounds the read of a file that is
// not a heap snapshot.
const MAX_HEADER_BYTES = 8 * 1024 * 1024;

const START_SIGNATURE = '"snapshot":';
const END_SIGNATURE = '"nodes":';

/**
 * Read the header of a `.heapsnapshot` file without parsing the heap graph.
 * Reads from the start of the file until the `nodes` array begins, so the cost
 * does not depend on the size of the snapshot.
 */
export function readSnapshotHeader(file: string): SnapshotHeader {
  const fileSizeBytes = fs.statSync(file).size;
  const text = readHeaderText(file);
  const start = text.indexOf(START_SIGNATURE);
  const end = text.indexOf(END_SIGNATURE);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(
      `${file} is not a heap snapshot: no "snapshot" header before "nodes"`,
    );
  }
  const json = text
    .slice(start + START_SIGNATURE.length, end)
    .trim()
    .replace(/,$/, '');
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(json);
  } catch {
    throw new Error(`${file}: the snapshot header is not valid JSON`);
  }
  const nodeFields = getNodeFields(meta);
  const traceFunctionCount = toCount(meta.trace_function_count);
  return {
    file,
    fileSizeBytes,
    nodeCount: requireCount(file, meta, 'node_count'),
    edgeCount: requireCount(file, meta, 'edge_count'),
    traceFunctionCount,
    extraNativeBytes: toCount(meta.extra_native_bytes),
    nodeFields,
    hasDetachedness: nodeFields.includes('detachedness'),
    hasAllocationStacks: traceFunctionCount > 0,
  };
}

function readHeaderText(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < MAX_HEADER_BYTES) {
      const chunk = Buffer.alloc(READ_CHUNK_BYTES);
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, total);
      if (bytesRead === 0) {
        break;
      }
      if (total === 0 && chunk[0] === 0x1f && chunk[1] === 0x8b) {
        throw new Error(
          `${file} is gzip-compressed; decompress it before reading it`,
        );
      }
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      // decoded as a whole so a multi-byte character split across two
      // chunks is not mangled
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.includes(END_SIGNATURE)) {
        return text;
      }
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function getNodeFields(meta: Record<string, unknown>): string[] {
  const inner = meta.meta as Record<string, unknown> | undefined;
  const fields = inner?.node_fields;
  return Array.isArray(fields) ? fields.map(f => `${f}`) : [];
}

/** An optional count: 0 when the header does not have it. */
function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * A count every snapshot header has. Reading a missing or malformed one as
 * 0 would understate the memory needed to analyze the snapshot, so it is an
 * error instead.
 */
function requireCount(
  file: string,
  meta: Record<string, unknown>,
  field: string,
): number {
  const value = meta[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `${file}: the snapshot header has no valid "${field}" (found ${JSON.stringify(value)})`,
    );
  }
  return value;
}

// Heap growth per node and per edge while memlab parses a snapshot and builds
// its dominator tree and retained sizes. Measured as the smallest
// --max-old-space-size that loads snapshots of 4M-48M nodes.
const ANALYSIS_BYTES_PER_NODE = 140;
const ANALYSIS_BYTES_PER_EDGE = 12;
// Share of the heap limit the analysis can be projected to need before it
// is flagged: the estimate is approximate and the analysis that follows the
// parse needs room of its own.
const HEAP_HEADROOM_FRACTION = 0.8;

/** Projected JS heap (MB) that memlab needs to analyze the snapshot. */
export function estimateAnalysisHeapMB(header: {
  nodeCount: number;
  edgeCount: number;
}): number {
  const bytes =
    header.nodeCount * ANALYSIS_BYTES_PER_NODE +
    header.edgeCount * ANALYSIS_BYTES_PER_EDGE;
  return Math.ceil(bytes / (1024 * 1024));
}

/** The heap limit (MB) of the running Node.js process. */
export function getHeapLimitMB(): number {
  return Math.floor(v8.getHeapStatistics().heap_size_limit / (1024 * 1024));
}

/**
 * The `--max-old-space-size` (MB) that leaves the usual headroom for a
 * projected analysis heap, or null when the given limit is already enough.
 */
export function suggestHeapLimitMB(
  projectedMB: number,
  heapLimitMB: number,
): number | null {
  if (projectedMB <= heapLimitMB * HEAP_HEADROOM_FRACTION) {
    return null;
  }
  return Math.ceil(projectedMB / HEAP_HEADROOM_FRACTION / 1024) * 1024;
}
