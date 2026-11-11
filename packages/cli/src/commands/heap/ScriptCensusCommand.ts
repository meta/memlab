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
import type {ScriptCensus} from '../../lib/heap/ScriptCensus';

import {BaseOption, info, utils} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import SnapshotFileOption from '../../options/heap/SnapshotFileOption';
import JSEngineOption from '../../options/heap/JSEngineOption';
import OutputFormatOption from '../../options/heap/OutputFormatOption';
import TopOption from '../../options/heap/TopOption';
import {censusScripts} from '../../lib/heap/ScriptCensus';
import {
  clipText,
  formatBytes,
  formatCount,
  formatPercent,
  isJsonOutput,
  renderTable,
  writeJsonOutput,
} from '../../lib/heap/HeapReportFormat';

function printCensus(file: string, census: ScriptCensus, top: number): void {
  info.topLevel(`Snapshot  ${file}`);
  info.lowLevel(
    `  ${formatCount(census.scriptCount)} scripts keep ` +
      `${formatBytes(census.totalSourceBytes)} of source text, ` +
      `${formatPercent(census.totalSourceBytes, census.totalHeapBytes)} of the heap`,
  );
  if (census.groups.length === 0) {
    return;
  }
  renderTable(
    ['script', 'scripts', 'copies', 'source', 'extra copies'],
    census.groups
      .slice(0, top)
      .map(g => [
        clipText(g.hasUrl ? g.key : JSON.stringify(g.key), 70),
        formatCount(g.scripts),
        formatCount(g.sources),
        formatBytes(g.sourceBytes),
        g.duplicateBytes > 0 ? formatBytes(g.duplicateBytes) : '-',
      ]),
    ['left', 'right', 'right', 'right', 'right'],
  ).forEach(line => info.topLevel(line));
  const duplicated = census.groups.filter(g => g.duplicateBytes > 0).length;
  if (duplicated > 0) {
    const scripts =
      duplicated === 1 ? '1 script has' : `${duplicated} scripts have`;
    info.warning(
      `${scripts} more than one copy of the source in memory; ` +
        'releasing the extra copies would free ' +
        `${formatBytes(census.duplicateBytes)}. A copy stays alive while any ` +
        'function compiled from it is reachable.',
    );
  }
}

export default class ScriptCensusCommand extends BaseCommand {
  getCommandName(): string {
    return 'script-census';
  }

  getDescription(): string {
    return (
      'report the source text of loaded scripts kept in a heap snapshot, ' +
      'and scripts kept in memory more than once'
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
    const census = censusScripts(snapshot);
    if (isJsonOutput()) {
      writeJsonOutput({
        file,
        ...census,
        groupCount: census.groups.length,
        groups: census.groups.slice(0, top),
      });
      return;
    }
    printCensus(file, census, top);
  }
}
