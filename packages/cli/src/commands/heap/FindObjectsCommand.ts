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
import type {FindObjectsResult} from '../../lib/heap/FindObjects';

import {analysis, BaseOption, info, utils} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import SnapshotFileOption from '../../options/heap/SnapshotFileOption';
import JSEngineOption from '../../options/heap/JSEngineOption';
import OutputFormatOption from '../../options/heap/OutputFormatOption';
import TopOption from '../../options/heap/TopOption';
import NamePatternOption from '../../options/heap/NamePatternOption';
import NodeTypeOption from '../../options/heap/NodeTypeOption';
import MinRetainedSizeOption from '../../options/heap/MinRetainedSizeOption';
import DetachedOnlyOption from '../../options/heap/DetachedOnlyOption';
import {findObjects} from '../../lib/heap/FindObjects';
import {
  clipText,
  formatBytes,
  formatCount,
  isJsonOutput,
  renderTable,
  writeJsonOutput,
} from '../../lib/heap/HeapReportFormat';

function printResult(file: string, result: FindObjectsResult): void {
  info.topLevel(`Snapshot  ${file}`);
  if (result.objects.length === 0) {
    info.lowLevel('  no object matches');
    return;
  }
  info.lowLevel(
    `  ${formatCount(result.matchCount)} objects match; the ` +
      `${formatCount(result.objects.length)} that retain the most:`,
  );
  renderTable(
    ['id', 'class', 'type', 'self size', 'retained size', 'detached'],
    result.objects.map(o => [
      `@${o.id}`,
      clipText(o.name, 60),
      o.type,
      formatBytes(o.selfSize),
      formatBytes(o.retainedSize),
      o.detached ? 'yes' : '',
    ]),
    ['left', 'left', 'left', 'right', 'right', 'left'],
  ).forEach(line => info.topLevel(line));
  info.lowLevel(
    `  why one is kept alive: memlab trace --snapshot ${file} ` +
      `--node-id ${result.objects[0].id}`,
  );
}

export default class FindObjectsCommand extends BaseCommand {
  getCommandName(): string {
    return 'find-objects';
  }

  getDescription(): string {
    return (
      'list the objects in a heap snapshot that match a class name, node ' +
      'type, retained size or detached state, largest retained size first'
    );
  }

  getCategory(): CommandCategory {
    return CommandCategory.COMMON;
  }

  getExamples(): CommandOptionExample[] {
    return [
      '--snapshot <HEAP_SNAPSHOT_FILE> --name-pattern ^Map$ --min-retained-size 1MB',
      '--snapshot <HEAP_SNAPSHOT_FILE> --detached --node-type native',
      '--snapshot <HEAP_SNAPSHOT_FILE> --node-type closure --top 50 --output json',
    ];
  }

  getOptions(): BaseOption[] {
    return [
      new SnapshotFileOption(),
      new JSEngineOption(),
      new NamePatternOption(),
      new NodeTypeOption(),
      new MinRetainedSizeOption(),
      new DetachedOnlyOption(),
      new TopOption(),
      new OutputFormatOption(),
    ];
  }

  async run(options: CLIOptions): Promise<void> {
    const args = options.cliArgs;
    const query = {
      namePattern: NamePatternOption.getValue(args),
      nodeType: NodeTypeOption.getValue(args),
      minRetainedSize: MinRetainedSizeOption.getValue(args),
      detachedOnly: DetachedOnlyOption.getValue(args),
    };
    const file = utils.getSingleSnapshotFileForAnalysis();
    const snapshot = await utils.getSnapshotFromFile(file, {});
    // computes the dominator tree and retained sizes
    analysis.preparePathFinder(snapshot);
    const result = findObjects(snapshot, query, TopOption.getValue(args));
    if (isJsonOutput()) {
      writeJsonOutput({file, ...result});
      return;
    }
    printResult(file, result);
  }
}
