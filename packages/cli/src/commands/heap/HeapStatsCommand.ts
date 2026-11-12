/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {CommandOptionExample} from '@memlab/core';
import type {HeapStats} from '../../lib/heap/HeapStats';

import {BaseOption, info, utils} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import SnapshotFileOption from '../../options/heap/SnapshotFileOption';
import JSEngineOption from '../../options/heap/JSEngineOption';
import OutputFormatOption from '../../options/heap/OutputFormatOption';
import {computeHeapStats} from '../../lib/heap/HeapStats';
import {
  formatBytes,
  formatPercent,
  isJsonOutput,
  renderTable,
  writeJsonOutput,
} from '../../lib/heap/HeapReportFormat';

function printStats(file: string, stats: HeapStats): void {
  const {total, native, v8Heap, composition} = stats;
  const row = (label: string, size: number): string[] => [
    label,
    formatBytes(size),
    formatPercent(size, total),
  ];
  info.topLevel(`Snapshot  ${file}`);
  const statistics = [
    row('total', total),
    row('V8 heap', v8Heap.total),
    row('  code', v8Heap.code),
    row('  strings', v8Heap.strings),
    row('  JS arrays', v8Heap.jsArrays),
    row('  system objects', v8Heap.system),
    row('  other', v8Heap.other),
    row('native', native.total),
    row('  typed arrays', native.typedArrays),
  ];
  if (stats.extraNativeBytes > 0) {
    statistics.push(row('  outside any node', stats.extraNativeBytes));
  }
  renderTable(
    ['statistics', 'size', 'share'],
    statistics,
    ['left', 'right', 'right'],
    [undefined, 'size'],
  ).forEach(line => info.topLevel(line));

  info.topLevel('');
  const nodesTotal = total - stats.extraNativeBytes;
  const share = (label: string, size: number): string[] => [
    label,
    formatBytes(size),
    formatPercent(size, nodesTotal),
  ];
  renderTable(
    ['why the memory exists', 'size', 'share'],
    [
      share('script source text', composition.scriptSource),
      share('compiled code and function metadata', composition.compiledCode),
      share('allocated by the program', composition.other),
    ],
    ['left', 'right', 'right'],
    [undefined, 'size'],
  ).forEach(line => info.topLevel(line));
  const loaded = composition.scriptSource + composition.compiledCode;
  if (nodesTotal > 0 && loaded / nodesTotal > 0.5) {
    info.warning(
      `${formatPercent(loaded, nodesTotal)} of this heap is loaded code, not ` +
        'objects the program allocated. Compare totals across snapshots of ' +
        'the same build only.',
    );
  }
}

export default class HeapStatsCommand extends BaseCommand {
  getCommandName(): string {
    return 'heap-stats';
  }

  getDescription(): string {
    return (
      'split the memory in a heap snapshot into code, strings, JS arrays, ' +
      'system objects and native memory, and into loaded code vs memory ' +
      'the program allocated'
    );
  }

  getCategory(): CommandCategory {
    return CommandCategory.COMMON;
  }

  getExamples(): CommandOptionExample[] {
    return [
      '--snapshot <HEAP_SNAPSHOT_FILE>',
      '--snapshot <HEAP_SNAPSHOT_FILE> --output json',
    ];
  }

  getOptions(): BaseOption[] {
    return [
      new SnapshotFileOption(),
      new JSEngineOption(),
      new OutputFormatOption(),
    ];
  }

  async run(): Promise<void> {
    const file = utils.getSingleSnapshotFileForAnalysis();
    const snapshot = await utils.getSnapshotFromFile(file, {});
    const stats = computeHeapStats(snapshot);
    if (isJsonOutput()) {
      writeJsonOutput({file, ...stats});
      return;
    }
    printStats(file, stats);
  }
}
