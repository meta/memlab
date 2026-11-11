/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {config, info, OutputFormat} from '@memlab/core';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** `1234567` -> `"1,234,567"` */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** `1536` -> `"1.5 KB"`. Negative values keep their sign. */
export function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? '-' : '';
  const abs = Math.abs(bytes);
  if (abs >= GB) {
    return `${sign}${(abs / GB).toFixed(2)} GB`;
  }
  if (abs >= MB) {
    return `${sign}${(abs / MB).toFixed(1)} MB`;
  }
  if (abs >= KB) {
    return `${sign}${(abs / KB).toFixed(1)} KB`;
  }
  return `${sign}${abs} B`;
}

/** Like `formatCount`, with an explicit `+` on positive values. */
export function formatSignedCount(n: number): string {
  return n > 0 ? `+${formatCount(n)}` : formatCount(n);
}

/** Like `formatBytes`, with an explicit `+` on positive values. */
export function formatSignedBytes(bytes: number): string {
  return bytes > 0 ? `+${formatBytes(bytes)}` : formatBytes(bytes);
}

/** `part` as a percentage of `total`, or `-` when the total is 0. */
export function formatPercent(part: number, total: number): string {
  return total > 0 ? `${((part / total) * 100).toFixed(1)}%` : '-';
}

/** Shorten text to `max` characters, ending in `...` when cut. */
export function clipText(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export type ColumnAlign = 'left' | 'right';

/**
 * Render rows as a plain-text table with a header and a dashed rule. Columns
 * listed as `right` are right-aligned, which is what numbers need to be
 * compared by eye.
 */
export function renderTable(
  headers: string[],
  rows: string[][],
  align: ColumnAlign[] = [],
): string[] {
  const widths = headers.map((header, col) =>
    Math.max(header.length, ...rows.map(row => (row[col] ?? '').length)),
  );
  const renderRow = (row: string[]): string =>
    row
      .map((cell, col) =>
        align[col] === 'right'
          ? cell.padStart(widths[col])
          : cell.padEnd(widths[col]),
      )
      .join('  ')
      .trimEnd();
  return [
    renderRow(headers),
    widths.map(w => '-'.repeat(w)).join('  '),
    ...rows.map(renderRow),
  ];
}

export function isJsonOutput(): boolean {
  return config.outputFormat === OutputFormat.Json;
}

/** Write one JSON document to stdout, for `--output json`. */
export function writeJsonOutput(value: unknown): void {
  info.writeOutput(JSON.stringify(value, null, 2));
  info.writeOutput('\n');
}
