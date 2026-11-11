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
import type {ClassTrendRow} from '../../lib/heap/ClassTrend';

import path from 'path';
import {BaseOption, config, info, utils} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import SnapshotDirectoryOption from '../../options/heap/SnapshotDirectoryOption';
import JSEngineOption from '../../options/heap/JSEngineOption';
import OutputFormatOption from '../../options/heap/OutputFormatOption';
import TopOption from '../../options/heap/TopOption';
import NamePatternOption from '../../options/heap/NamePatternOption';
import optionConstants from '../../options/lib/OptionConstant';
import {buildClassHistogram} from '../../lib/heap/ClassHistogram';
import {buildClassTrend} from '../../lib/heap/ClassTrend';
import {
  clipText,
  formatCount,
  formatSignedBytes,
  formatSignedCount,
  isJsonOutput,
  renderTable,
  writeJsonOutput,
} from '../../lib/heap/HeapReportFormat';

// with more snapshots than this, the middle counts are elided
const MAX_COUNTS_SHOWN = 6;

function formatCounts(counts: number[]): string {
  const shown =
    counts.length <= MAX_COUNTS_SHOWN
      ? counts.map(formatCount)
      : [
          ...counts.slice(0, 2).map(formatCount),
          '...',
          ...counts.slice(-2).map(formatCount),
        ];
  return shown.join(' > ');
}

function printTrend(files: string[], rows: ClassTrendRow[], top: number): void {
  info.topLevel(
    `${formatCount(files.length)} snapshots, in order: ` +
      files.map(f => path.basename(f)).join(', '),
  );
  const grows = rows.filter(r => r.trend === 'grows').length;
  info.lowLevel(
    `  ${formatCount(grows)} classes grew at every step; ` +
      `${formatCount(rows.length)} classes changed overall`,
  );
  if (rows.length === 0) {
    return;
  }
  renderTable(
    ['class', 'type', 'trend', 'counts', 'delta', 'self size delta'],
    rows
      .slice(0, top)
      .map(r => [
        clipText(r.name, 60),
        r.type,
        r.trend,
        formatCounts(r.counts),
        formatSignedCount(r.countDelta),
        formatSignedBytes(r.selfSizeDelta),
      ]),
    ['left', 'left', 'left', 'left', 'right', 'right'],
  ).forEach(line => info.topLevel(line));
}

export default class ClassTrendCommand extends BaseCommand {
  getCommandName(): string {
    return 'class-trend';
  }

  getDescription(): string {
    return (
      'track the number of objects per class across a series of heap ' +
      'snapshots, and list the classes that grew at every step'
    );
  }

  getCategory(): CommandCategory {
    return CommandCategory.COMMON;
  }

  getExamples(): CommandOptionExample[] {
    return [
      '--snapshot-dir <DIR_CONTAINING_SNAPSHOTS>',
      '--snapshot-dir <DIR> --name-pattern Detached --output json',
    ];
  }

  getOptions(): BaseOption[] {
    return [
      new SnapshotDirectoryOption(),
      new JSEngineOption(),
      new TopOption(),
      new NamePatternOption(),
      new OutputFormatOption(),
    ];
  }

  async run(options: CLIOptions): Promise<void> {
    const top = TopOption.getValue(options.cliArgs);
    const namePattern = NamePatternOption.getValue(options.cliArgs);
    if (!config.externalSnapshotDir) {
      utils.haltOrThrow(
        `class-trend needs --${optionConstants.optionNames.SNAPSHOT_DIR}`,
      );
      return;
    }
    const files = utils.getSnapshotFilesInDir(config.externalSnapshotDir);
    if (files.length < 2) {
      utils.haltOrThrow(
        `class-trend needs at least 2 .heapsnapshot files in ` +
          `${config.externalSnapshotDir}, found ${files.length}`,
      );
      return;
    }
    // one snapshot in memory at a time; only its histogram is kept
    const histograms: ClassHistogram[] = [];
    for (const file of files) {
      const snapshot = await utils.getSnapshotFromFile(file, {});
      histograms.push(buildClassHistogram(snapshot, {namePattern}));
    }
    const rows = buildClassTrend(histograms).filter(
      r => r.countDelta !== 0 || r.selfSizeDelta !== 0,
    );
    if (isJsonOutput()) {
      writeJsonOutput({
        snapshots: files,
        changedClassCount: rows.length,
        rows: rows.slice(0, top),
      });
      return;
    }
    printTrend(files, rows, top);
  }
}
