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
import chalk from 'chalk';

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
 * How a column is colored in a terminal, matching the colors of retainer
 * traces: `name` for classes and objects, `id` for `@id`s, `size` for byte
 * sizes, `delta` for signed changes (growth in red, shrinking in green),
 * `flag` for yes/no columns (`yes` in yellow), and `muted` for secondary
 * details. Only the 16 basic colors are used, so every
 * terminal that shows colors can show them.
 */
export type ColumnStyle = 'name' | 'id' | 'size' | 'delta' | 'flag' | 'muted';

function styleCell(text: string, style: ColumnStyle | undefined): string {
  if (text === '-') {
    return chalk.grey(text);
  }
  switch (style) {
    case 'name':
      return chalk.green(text);
    case 'id':
    case 'muted':
      return chalk.grey(text);
    case 'size':
      return chalk.blue(text);
    case 'flag':
      return text === 'yes' ? chalk.yellow(text) : chalk.grey(text);
    case 'delta':
      if (text.startsWith('+')) {
        return chalk.red(text);
      }
      return text.startsWith('-') ? chalk.green(text) : text;
    default:
      return text;
  }
}

// colors the text of a padded cell, leaving the padding uncolored
function colorPadded(cell: string, color: (text: string) => string): string {
  return cell.replace(/\S(.*\S)?/, color);
}

/**
 * Render rows as a text table with a header and a dashed rule. Columns
 * listed as `right` are right-aligned, which is what numbers need to be
 * compared by eye. `styles` colors each column (see `ColumnStyle`); chalk
 * leaves the text plain when the output is not a terminal that shows colors.
 */
export function renderTable(
  headers: string[],
  rows: string[][],
  align: ColumnAlign[] = [],
  styles: Array<ColumnStyle | undefined> = [],
): string[] {
  const widths = headers.map((header, col) =>
    Math.max(header.length, ...rows.map(row => (row[col] ?? '').length)),
  );
  const renderRow = (
    row: string[],
    color: (text: string, col: number) => string,
  ): string =>
    row
      .map((cell, col) =>
        colorPadded(
          align[col] === 'right'
            ? cell.padStart(widths[col])
            : cell.padEnd(widths[col]),
          text => color(text, col),
        ),
      )
      .join('  ')
      .trimEnd();
  return [
    renderRow(headers, text => chalk.bold(text)),
    chalk.grey(widths.map(w => '-'.repeat(w)).join('  ')),
    ...rows.map(row =>
      renderRow(row, (text, col) => styleCell(text, styles[col])),
    ),
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
