/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {CLIOptions, CommandOptionExample} from '@memlab/core';
import type {ClassHistogram} from '../../lib/heap/ClassHistogram';

import {BaseOption, info, utils} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import SnapshotFileOption from '../../options/heap/SnapshotFileOption';
import JSEngineOption from '../../options/heap/JSEngineOption';
import OutputFormatOption from '../../options/heap/OutputFormatOption';
import TopOption from '../../options/heap/TopOption';
import NamePatternOption from '../../options/heap/NamePatternOption';
import {buildClassHistogram} from '../../lib/heap/ClassHistogram';
import {
  clipText,
  formatBytes,
  formatCount,
  formatPercent,
  isJsonOutput,
  renderTable,
  writeJsonOutput,
} from '../../lib/heap/HeapReportFormat';

function printHistogram(
  file: string,
  histogram: ClassHistogram,
  top: number,
): void {
  const {rows, totalCount, totalSelfSize} = histogram;
  info.topLevel(`Snapshot  ${file}`);
  if (rows.length === 0) {
    info.lowLevel('  no class matches');
    return;
  }
  const shown = rows.slice(0, top);
  info.lowLevel(
    `  top ${formatCount(shown.length)} of ${formatCount(rows.length)} classes ` +
      `by self size; ${formatCount(totalCount)} objects, ${formatBytes(totalSelfSize)}`,
  );
  const lines = renderTable(
    ['class', 'type', 'count', 'self size', 'share'],
    shown.map(row => [
      clipText(row.name),
      row.type,
      formatCount(row.count),
      formatBytes(row.selfSize),
      formatPercent(row.selfSize, totalSelfSize),
    ]),
    ['left', 'left', 'right', 'right', 'right'],
  );
  lines.forEach(line => info.topLevel(line));
}

export default class ClassHistogramCommand extends BaseCommand {
  getCommandName(): string {
    return 'class-histogram';
  }

  getDescription(): string {
    return (
      'print the number of objects and their total self size per class in a ' +
      'heap snapshot'
    );
  }

  getCategory(): CommandCategory {
    return CommandCategory.COMMON;
  }

  getExamples(): CommandOptionExample[] {
    return [
      '--snapshot <HEAP_SNAPSHOT_FILE>',
      '--snapshot <HEAP_SNAPSHOT_FILE> --top 100',
      '--snapshot <HEAP_SNAPSHOT_FILE> --name-pattern Detached',
      '--snapshot <HEAP_SNAPSHOT_FILE> --output json',
    ];
  }

  getOptions(): BaseOption[] {
    return [
      new SnapshotFileOption(),
      new JSEngineOption(),
      new TopOption(),
      new NamePatternOption(),
      new OutputFormatOption(),
    ];
  }

  async run(options: CLIOptions): Promise<void> {
    const top = TopOption.getValue(options.cliArgs);
    const namePattern = NamePatternOption.getValue(options.cliArgs);
    const file = utils.getSingleSnapshotFileForAnalysis();
    // counts and self sizes need no dominator tree, so it is not built
    const snapshot = await utils.getSnapshotFromFile(file, {
      buildNodeIdIndex: false,
    });
    const histogram = buildClassHistogram(snapshot, {namePattern});
    if (isJsonOutput()) {
      writeJsonOutput({
        file,
        classCount: histogram.rows.length,
        totalCount: histogram.totalCount,
        totalSelfSize: histogram.totalSelfSize,
        rows: histogram.rows.slice(0, top),
      });
      return;
    }
    printHistogram(file, histogram, top);
  }
}
