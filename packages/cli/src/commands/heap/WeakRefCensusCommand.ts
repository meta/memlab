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
import type {WeakRefCensus} from '../../lib/heap/WeakRefCensus';

import {BaseOption, info, utils} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import SnapshotFileOption from '../../options/heap/SnapshotFileOption';
import JSEngineOption from '../../options/heap/JSEngineOption';
import OutputFormatOption from '../../options/heap/OutputFormatOption';
import TopOption from '../../options/heap/TopOption';
import {censusWeakRefs} from '../../lib/heap/WeakRefCensus';
import {
  clipText,
  formatCount,
  formatPercent,
  isJsonOutput,
  renderTable,
  writeJsonOutput,
} from '../../lib/heap/HeapReportFormat';

// a holder this empty, with this many WeakRefs, is reported as suspect
const SUSPECT_EMPTY_SHARE = 0.5;
const SUSPECT_MIN_COUNT = 5;

function printCensus(file: string, census: WeakRefCensus, top: number): void {
  info.topLevel(`Snapshot  ${file}`);
  if (census.total === 0) {
    info.lowLevel('  no WeakRef objects');
    return;
  }
  info.lowLevel(
    `  ${formatCount(census.total)} WeakRefs: ` +
      `${formatCount(census.total - census.empty)} live, ` +
      `${formatCount(census.empty)} empty (target already collected)`,
  );
  renderTable(
    ['held by', 'WeakRefs', 'empty', 'share empty', 'example holder'],
    census.holders
      .slice(0, top)
      .map(h => [
        clipText(h.holder, 60),
        formatCount(h.total),
        formatCount(h.empty),
        formatPercent(h.empty, h.total),
        h.exampleId > 0 ? `@${h.exampleId}` : '-',
      ]),
    ['left', 'right', 'right', 'right', 'left'],
  ).forEach(line => info.topLevel(line));
  const suspects = census.holders.filter(
    h =>
      h.total >= SUSPECT_MIN_COUNT && h.empty / h.total > SUSPECT_EMPTY_SHARE,
  );
  for (const h of suspects) {
    info.warning(
      `${formatPercent(h.empty, h.total)} of the WeakRefs held by ` +
        `${clipText(h.holder, 60)} are empty: entries are kept after their ` +
        'target is collected. Remove them when deref() returns undefined, or ' +
        'with a FinalizationRegistry.',
    );
  }
}

export default class WeakRefCensusCommand extends BaseCommand {
  getCommandName(): string {
    return 'weakref-census';
  }

  getDescription(): string {
    return (
      'count the WeakRefs in a heap snapshot, live vs empty, grouped by ' +
      'what holds them'
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
      new TopOption(),
      new OutputFormatOption(),
    ];
  }

  async run(options: CLIOptions): Promise<void> {
    const top = TopOption.getValue(options.cliArgs);
    const file = utils.getSingleSnapshotFileForAnalysis();
    const snapshot = await utils.getSnapshotFromFile(file, {});
    const census = censusWeakRefs(snapshot);
    if (isJsonOutput()) {
      writeJsonOutput({
        file,
        ...census,
        holderCount: census.holders.length,
        holders: census.holders.slice(0, top),
      });
      return;
    }
    printCensus(file, census, top);
  }
}
