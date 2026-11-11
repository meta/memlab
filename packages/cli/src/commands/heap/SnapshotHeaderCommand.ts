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
import type {SnapshotHeader} from '../../lib/heap/SnapshotHeader';

import {BaseOption, config, info, utils} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import SnapshotFileOption from '../../options/heap/SnapshotFileOption';
import SnapshotDirectoryOption from '../../options/heap/SnapshotDirectoryOption';
import OutputFormatOption from '../../options/heap/OutputFormatOption';
import {
  estimateAnalysisHeapMB,
  getHeapLimitMB,
  readSnapshotHeader,
  suggestHeapLimitMB,
} from '../../lib/heap/SnapshotHeader';
import {
  formatBytes,
  formatCount,
  isJsonOutput,
  renderTable,
  writeJsonOutput,
} from '../../lib/heap/HeapReportFormat';

type HeaderReport = SnapshotHeader & {
  projectedAnalysisHeapMB: number;
  heapLimitMB: number;
  suggestedMaxOldSpaceSizeMB: number | null;
};

function toReport(header: SnapshotHeader, heapLimitMB: number): HeaderReport {
  const projectedAnalysisHeapMB = estimateAnalysisHeapMB(header);
  return {
    ...header,
    projectedAnalysisHeapMB,
    heapLimitMB,
    suggestedMaxOldSpaceSizeMB: suggestHeapLimitMB(
      projectedAnalysisHeapMB,
      heapLimitMB,
    ),
  };
}

function yesNo(value: boolean): string {
  return value ? 'recorded' : 'not recorded';
}

function field(label: string, value: string): void {
  info.lowLevel(`  ${label.padEnd(22)}${value}`);
}

function printOne(report: HeaderReport): void {
  const edgesPerNode =
    report.nodeCount > 0
      ? (report.edgeCount / report.nodeCount).toFixed(1)
      : '-';
  info.topLevel(`Snapshot  ${report.file}`);
  field('file size', formatBytes(report.fileSizeBytes));
  field('nodes', formatCount(report.nodeCount));
  field('edges', `${formatCount(report.edgeCount)} (${edgesPerNode} per node)`);
  if (report.extraNativeBytes > 0) {
    field('native outside nodes', formatBytes(report.extraNativeBytes));
  }
  field(
    'allocation stacks',
    yesNo(report.hasAllocationStacks) +
      (report.hasAllocationStacks
        ? ` (${formatCount(report.traceFunctionCount)} functions)`
        : ''),
  );
  field('detachedness', yesNo(report.hasDetachedness));
  info.topLevel('Memory needed to analyze it');
  info.lowLevel(
    `  about ${formatCount(report.projectedAnalysisHeapMB)} MB of JS heap; ` +
      `this Node.js process has ${formatCount(report.heapLimitMB)} MB`,
  );
  printHeapHint(report.suggestedMaxOldSpaceSizeMB);
}

function printHeapHint(suggestedMB: number | null): void {
  if (suggestedMB == null) {
    return;
  }
  info.warning(
    `memlab is likely to run out of memory on this snapshot. Re-run with ` +
      `NODE_OPTIONS=--max-old-space-size=${suggestedMB}`,
  );
}

function printMany(reports: HeaderReport[], heapLimitMB: number): void {
  const rows = reports.map(r => [
    r.file,
    formatBytes(r.fileSizeBytes),
    formatCount(r.nodeCount),
    formatCount(r.edgeCount),
    r.hasAllocationStacks ? 'yes' : 'no',
    `${formatCount(r.projectedAnalysisHeapMB)} MB`,
  ]);
  const lines = renderTable(
    ['snapshot', 'size', 'nodes', 'edges', 'alloc stacks', 'heap needed'],
    rows,
    ['left', 'right', 'right', 'right', 'left', 'right'],
  );
  lines.forEach(line => info.topLevel(line));
  info.lowLevel(
    `this Node.js process has ${formatCount(heapLimitMB)} MB of JS heap`,
  );
  const largest = Math.max(...reports.map(r => r.projectedAnalysisHeapMB));
  printHeapHint(suggestHeapLimitMB(largest, heapLimitMB));
}

export default class SnapshotHeaderCommand extends BaseCommand {
  getCommandName(): string {
    return 'snapshot-header';
  }

  getDescription(): string {
    return (
      'print node and edge counts and the memory needed to analyze a heap ' +
      'snapshot, read from its header without parsing the snapshot'
    );
  }

  getCategory(): CommandCategory {
    return CommandCategory.COMMON;
  }

  getExamples(): CommandOptionExample[] {
    return [
      '--snapshot <HEAP_SNAPSHOT_FILE>',
      '--snapshot-dir <DIR_CONTAINING_SNAPSHOTS>',
      '--snapshot <HEAP_SNAPSHOT_FILE> --output json',
    ];
  }

  getOptions(): BaseOption[] {
    return [
      new SnapshotFileOption(),
      new SnapshotDirectoryOption(),
      new OutputFormatOption(),
    ];
  }

  async run(): Promise<void> {
    const files = config.externalSnapshotDir
      ? utils.getSnapshotFilesInDir(utils.getSnapshotDirForAnalysis())
      : [utils.getSingleSnapshotFileForAnalysis()];
    if (files.length === 0) {
      utils.haltOrThrow(
        `no .heapsnapshot files in ${config.externalSnapshotDir}`,
      );
      return;
    }
    const heapLimitMB = getHeapLimitMB();
    const reports = files.map(file =>
      toReport(readSnapshotHeader(file), heapLimitMB),
    );
    if (isJsonOutput()) {
      writeJsonOutput(config.externalSnapshotDir ? reports : reports[0]);
    } else if (config.externalSnapshotDir) {
      printMany(reports, heapLimitMB);
    } else {
      printOne(reports[0]);
    }
  }
}
