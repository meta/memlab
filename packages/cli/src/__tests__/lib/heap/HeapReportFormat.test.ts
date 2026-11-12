/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {config, OutputFormat} from '@memlab/core';
import chalk from 'chalk';
import {
  clipText,
  formatBytes,
  formatCount,
  formatPercent,
  formatSignedBytes,
  formatSignedCount,
  isJsonOutput,
  renderTable,
} from '../../../lib/heap/HeapReportFormat';

beforeEach(() => {
  config.isTest = true;
  config.outputFormat = OutputFormat.Text;
});

test('formats counts with thousands separators', () => {
  expect(formatCount(0)).toBe('0');
  expect(formatCount(1234567)).toBe('1,234,567');
  expect(formatCount(-4500)).toBe('-4,500');
  expect(formatCount(12.6)).toBe('13');
  expect(formatSignedCount(300)).toBe('+300');
  expect(formatSignedCount(0)).toBe('0');
  expect(formatSignedCount(-2)).toBe('-2');
});

test('formats byte sizes in the largest fitting unit', () => {
  expect(formatBytes(0)).toBe('0 B');
  expect(formatBytes(1023)).toBe('1023 B');
  expect(formatBytes(1536)).toBe('1.5 KB');
  expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB');
  expect(formatBytes(-2048)).toBe('-2.0 KB');
  expect(formatSignedBytes(2048)).toBe('+2.0 KB');
  expect(formatSignedBytes(-16)).toBe('-16 B');
  expect(formatSignedBytes(0)).toBe('0 B');
});

test('formats percentages and guards a zero total', () => {
  expect(formatPercent(1, 4)).toBe('25.0%');
  expect(formatPercent(1, 3)).toBe('33.3%');
  expect(formatPercent(5, 0)).toBe('-');
});

test('clips long text with an ellipsis', () => {
  expect(clipText('short')).toBe('short');
  expect(clipText('x'.repeat(80))).toBe('x'.repeat(80));
  expect(clipText('x'.repeat(81))).toBe(`${'x'.repeat(77)}...`);
  expect(clipText('abcdefghij', 6)).toBe('abc...');
});

test('renders an aligned table', () => {
  expect(
    renderTable(
      ['class', 'count'],
      [
        ['Foo', '1'],
        ['LongerName', '1,234'],
      ],
      ['left', 'right'],
    ),
  ).toEqual([
    'class       count',
    '----------  -----',
    'Foo             1',
    'LongerName  1,234',
  ]);
  // a header wider than every cell sets the column width
  expect(renderTable(['a very long header'], [['x']])).toEqual([
    'a very long header',
    '------------------',
    'x',
  ]);
});

test('colors table columns without breaking the alignment', () => {
  const headers = ['id', 'class', 'size', 'delta', 'detached'];
  const rows = [
    ['@12', 'Foo', '1.0 KB', '+2', 'yes'],
    ['@345', 'LongerName', '-', '-3', 'no'],
  ];
  const align: Array<'left' | 'right'> = ['left', 'left', 'right', 'right'];
  const level = chalk.level;
  chalk.level = 0;
  const plain = renderTable(headers, rows, align);
  chalk.level = 1;
  try {
    const colored = renderTable(headers, rows, align, [
      'id',
      'name',
      'size',
      'delta',
      'flag',
    ]);
    const colorCode = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
    const strip = (line: string) => line.replace(colorCode, '');
    expect(colored.map(strip)).toEqual(plain);
    const [header, rule, first, second] = colored;
    expect(header).toContain(chalk.bold('class'));
    expect(rule).toBe(chalk.grey(strip(rule)));
    expect(first).toContain(chalk.grey('@12'));
    expect(first).toContain(chalk.green('Foo'));
    expect(first).toContain(chalk.blue('1.0 KB'));
    expect(first).toContain(chalk.red('+2'));
    expect(first).toContain(chalk.yellow('yes'));
    expect(second).toContain(chalk.grey('-'));
    expect(second).toContain(chalk.green('-3'));
    expect(second).toContain(chalk.grey('no'));
    // padding stays outside the colors, so rows end without spaces
    expect(colored.every(line => !/ $/.test(strip(line)))).toBe(true);
  } finally {
    chalk.level = level;
  }
});

test('reports whether JSON output was requested', () => {
  expect(isJsonOutput()).toBe(false);
  config.outputFormat = OutputFormat.Json;
  expect(isJsonOutput()).toBe(true);
});
