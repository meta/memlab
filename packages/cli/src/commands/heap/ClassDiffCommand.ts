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
import type {
  ClassDiffRow,
  HeapIdentity,
  NodeSample,
} from '../../lib/heap/ClassDiff';

import {BaseOption, config, info, NumericSet, utils} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import BaselineFileOption from '../../options/heap/BaselineFileOption';
import TargetFileOption from '../../options/heap/TargetFileOption';
import JSEngineOption from '../../options/heap/JSEngineOption';
import OutputFormatOption from '../../options/heap/OutputFormatOption';
import TopOption from '../../options/heap/TopOption';
import NamePatternOption from '../../options/heap/NamePatternOption';
import optionConstants from '../../options/lib/OptionConstant';
import {buildClassHistogram} from '../../lib/heap/ClassHistogram';
import {
  addNewObjectCounts,
  collectStableIds,
  compareHeapIdentity,
  diffClassHistograms,
  sampleNodes,
} from '../../lib/heap/ClassDiff';
import {
  clipText,
  formatBytes,
  formatCount,
  formatSignedBytes,
  formatSignedCount,
  isJsonOutput,
  renderTable,
  writeJsonOutput,
} from '../../lib/heap/HeapReportFormat';

type DiffReport = {
  baseline: string;
  target: string;
  baselineTotal: {count: number; selfSize: number};
  targetTotal: {count: number; selfSize: number};
  heapIdentity: HeapIdentity;
  rows: ClassDiffRow[];
};

function total(histogram: ClassHistogram): {count: number; selfSize: number} {
  return {count: histogram.totalCount, selfSize: histogram.totalSelfSize};
}

/**
 * What the comparison needs from the baseline. The baseline snapshot itself
 * goes out of scope before the target is loaded, so only one parsed snapshot
 * is in memory at a time.
 */
async function summarizeBaseline(
  file: string,
  namePattern: RegExp | null,
): Promise<{
  histogram: ClassHistogram;
  ids: NumericSet;
  sample: NodeSample[];
}> {
  const snapshot = await utils.getSnapshotFromFile(file, {});
  return {
    histogram: buildClassHistogram(snapshot, {namePattern}),
    ids: collectStableIds(snapshot),
    sample: sampleNodes(snapshot),
  };
}

function printReport(report: DiffReport, top: number): void {
  const {baselineTotal: b, targetTotal: t, heapIdentity} = report;
  info.topLevel(`Baseline  ${report.baseline}`);
  info.topLevel(`Target    ${report.target}`);
  info.lowLevel(
    `  objects    ${formatCount(b.count)} -> ${formatCount(t.count)} ` +
      `(${formatSignedCount(t.count - b.count)})`,
  );
  info.lowLevel(
    `  self size  ${formatBytes(b.selfSize)} -> ${formatBytes(t.selfSize)} ` +
      `(${formatSignedBytes(t.selfSize - b.selfSize)})`,
  );
  if (heapIdentity.sameHeap) {
    info.lowLevel(
      '  same JS heap: "new" counts objects allocated after the baseline that are still alive',
    );
  } else {
    info.lowLevel(
      '  different JS heaps (or too few shared objects to tell): only counts are compared',
    );
  }
  const changed = report.rows;
  if (changed.length === 0) {
    info.topLevel('No class changed');
    return;
  }
  const shown = changed.slice(0, top);
  info.topLevel(
    `Top ${formatCount(shown.length)} of ${formatCount(changed.length)} ` +
      'changed classes by self-size growth',
  );
  const headers = ['class', 'type', 'count', 'delta', 'self size', 'delta'];
  const align: Array<'left' | 'right'> = [
    'left',
    'left',
    'right',
    'right',
    'right',
    'right',
  ];
  if (heapIdentity.sameHeap) {
    headers.push('new');
    align.push('right');
  }
  const rows = shown.map(r => {
    const cells = [
      clipText(r.name),
      r.type,
      formatCount(r.targetCount),
      formatSignedCount(r.countDelta),
      formatBytes(r.targetSelfSize),
      formatSignedBytes(r.selfSizeDelta),
    ];
    if (heapIdentity.sameHeap) {
      cells.push(r.newCount == null ? '-' : formatCount(r.newCount));
    }
    return cells;
  });
  renderTable(headers, rows, align).forEach(line => info.topLevel(line));
}

export default class ClassDiffCommand extends BaseCommand {
  getCommandName(): string {
    return 'class-diff';
  }

  getDescription(): string {
    return (
      'compare the number of objects and their self size per class between ' +
      'two heap snapshots'
    );
  }

  getCategory(): CommandCategory {
    return CommandCategory.COMMON;
  }

  getExamples(): CommandOptionExample[] {
    return [
      '--baseline <HEAP_SNAPSHOT_FILE> --target <HEAP_SNAPSHOT_FILE>',
      '--baseline <FILE> --target <FILE> --top 50 --name-pattern Detached',
      '--baseline <FILE> --target <FILE> --output json',
    ];
  }

  getOptions(): BaseOption[] {
    return [
      new BaselineFileOption(),
      new TargetFileOption(),
      new JSEngineOption(),
      new TopOption(),
      new NamePatternOption(),
      new OutputFormatOption(),
    ];
  }

  async run(options: CLIOptions): Promise<void> {
    const top = TopOption.getValue(options.cliArgs);
    const namePattern = NamePatternOption.getValue(options.cliArgs);
    const [baselineFile, targetFile] = config.externalSnapshotFilePaths;
    if (!baselineFile || !targetFile) {
      const names = optionConstants.optionNames;
      utils.haltOrThrow(
        `class-diff needs both --${names.BASELINE} and --${names.TARGET}`,
      );
      return;
    }

    const baseline = await summarizeBaseline(baselineFile, namePattern);
    const target = await utils.getSnapshotFromFile(targetFile, {});
    const targetHistogram = buildClassHistogram(target, {namePattern});
    const heapIdentity = compareHeapIdentity(baseline.sample, target);
    const rows = diffClassHistograms(
      baseline.histogram,
      targetHistogram,
    ).filter(r => r.countDelta !== 0 || r.selfSizeDelta !== 0);
    if (heapIdentity.sameHeap) {
      addNewObjectCounts(rows, target, baseline.ids, namePattern);
    }

    const report: DiffReport = {
      baseline: baselineFile,
      target: targetFile,
      baselineTotal: total(baseline.histogram),
      targetTotal: total(targetHistogram),
      heapIdentity,
      rows,
    };
    if (isJsonOutput()) {
      writeJsonOutput({
        ...report,
        changedClassCount: rows.length,
        rows: rows.slice(0, top),
      });
      return;
    }
    printReport(report, top);
  }
}
