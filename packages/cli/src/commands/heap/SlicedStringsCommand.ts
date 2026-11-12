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
import type {SlicedStringReport} from '../../lib/heap/SlicedStrings';

import {BaseOption, info, utils} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import SnapshotFileOption from '../../options/heap/SnapshotFileOption';
import JSEngineOption from '../../options/heap/JSEngineOption';
import OutputFormatOption from '../../options/heap/OutputFormatOption';
import TopOption from '../../options/heap/TopOption';
import {findSlicedStringParents} from '../../lib/heap/SlicedStrings';
import {
  clipText,
  formatBytes,
  formatCount,
  isJsonOutput,
  renderTable,
  writeJsonOutput,
} from '../../lib/heap/HeapReportFormat';

function printReport(
  file: string,
  report: SlicedStringReport,
  top: number,
): void {
  info.topLevel(`Snapshot  ${file}`);
  info.lowLevel(
    `  ${formatCount(report.slicedCount)} sliced strings point into ` +
      `${formatCount(report.parents.length)} parent strings`,
  );
  if (report.parents.length === 0) {
    return;
  }
  const pinned = report.parents.filter(p => p.heldOnlyBySlices).length;
  info.lowLevel(
    `  ${formatBytes(report.pinnedSize)} in ${formatCount(pinned)} parents ` +
      'is kept alive only by slices; copying the slices would free it',
  );
  const shown = report.parents.slice(0, top);
  renderTable(
    ['parent', 'size', 'slices', 'only slices hold it', 'text'],
    shown.map(p => [
      `@${p.id}`,
      formatBytes(p.size),
      formatCount(p.sliceCount),
      p.heldOnlyBySlices ? 'yes' : 'no',
      clipText(JSON.stringify(p.preview), 60),
    ]),
    ['left', 'right', 'right', 'left', 'left'],
    ['id', 'size', undefined, 'flag'],
  ).forEach(line => info.topLevel(line));
}

export default class SlicedStringsCommand extends BaseCommand {
  getCommandName(): string {
    return 'sliced-strings';
  }

  getDescription(): string {
    return (
      'find large strings kept alive by short substrings (V8 sliced ' +
      'strings) in a heap snapshot'
    );
  }

  getCategory(): CommandCategory {
    return CommandCategory.COMMON;
  }

  getExamples(): CommandOptionExample[] {
    return [
      '--snapshot <HEAP_SNAPSHOT_FILE>',
      '--snapshot <HEAP_SNAPSHOT_FILE> --top 50 --output json',
    ];
  }

  getOptions(): BaseOption[] {
    return [
      new SnapshotFileOption(),
      new JSEngineOption(),
      new TopOption(),
      new OutputFormatOption(),
    ];
  }

  async run(options: CLIOptions): Promise<void> {
    const top = TopOption.getValue(options.cliArgs);
    const file = utils.getSingleSnapshotFileForAnalysis();
    const snapshot = await utils.getSnapshotFromFile(file, {});
    const report = findSlicedStringParents(snapshot);
    if (isJsonOutput()) {
      writeJsonOutput({
        file,
        ...report,
        parentCount: report.parents.length,
        parents: report.parents.slice(0, top),
      });
      return;
    }
    printReport(file, report, top);
  }
}
