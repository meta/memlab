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
import type {DomAudit, DomBucket} from '../../lib/heap/DomAudit';

import {BaseOption, info, utils} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import SnapshotFileOption from '../../options/heap/SnapshotFileOption';
import OutputFormatOption from '../../options/heap/OutputFormatOption';
import TopOption from '../../options/heap/TopOption';
import {auditDom} from '../../lib/heap/DomAudit';
import {
  clipText,
  formatBytes,
  formatCount,
  isJsonOutput,
  renderTable,
  writeJsonOutput,
} from '../../lib/heap/HeapReportFormat';

// fewer repeats than this rarely repay the complexity of virtualizing a list
const MIN_REPEAT = 20;

function printBuckets(title: string, buckets: DomBucket[], top: number): void {
  renderTable(
    [title, 'count', 'self size'],
    buckets
      .slice(0, top)
      .map(b => [
        clipText(b.key, 70),
        formatCount(b.count),
        formatBytes(b.selfSize),
      ]),
    ['left', 'right', 'right'],
    ['name', undefined, 'size'],
  ).forEach(line => info.topLevel(line));
}

function printAudit(file: string, audit: DomAudit, top: number): void {
  info.topLevel(`Snapshot  ${file}`);
  if (audit.attached === 0) {
    info.lowLevel(
      '  no attached DOM elements: a Node.js snapshot, or a page that had not built its UI yet',
    );
    return;
  }
  info.lowLevel(
    `  ${formatCount(audit.attached)} attached elements ` +
      `(${formatBytes(audit.attachedSelfSize)}), plus ` +
      `${formatCount(audit.sideDataCount)} per-element style and data objects ` +
      `(${formatBytes(audit.sideDataSize)})`,
  );
  info.lowLevel(
    `  ${formatCount(audit.detached)} detached elements are not counted; ` +
      'see memlab analyze detached-DOM',
  );
  printBuckets('tag', audit.byTag, top);
  info.topLevel('');
  if (audit.repeated.length === 0) {
    info.lowLevel(
      `  no element is repeated ${MIN_REPEAT} or more times: no list to virtualize`,
    );
    return;
  }
  info.topLevel(
    `Elements repeated ${MIN_REPEAT} or more times (candidates for list virtualization)`,
  );
  printBuckets('element', audit.repeated, top);
  info.lowLevel(
    '  each row is one element type; a list item built from several elements ' +
      'shows up as several rows with the same count',
  );
}

export default class DomAuditCommand extends BaseCommand {
  getCommandName(): string {
    return 'dom-audit';
  }

  getDescription(): string {
    return (
      'count the DOM elements attached to the document in a browser heap ' +
      'snapshot, by tag and by repeated element'
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
      new TopOption(),
      new OutputFormatOption(),
    ];
  }

  async run(options: CLIOptions): Promise<void> {
    const top = TopOption.getValue(options.cliArgs);
    const file = utils.getSingleSnapshotFileForAnalysis();
    const snapshot = await utils.getSnapshotFromFile(file, {});
    const audit = auditDom(snapshot, MIN_REPEAT);
    if (isJsonOutput()) {
      writeJsonOutput({
        file,
        ...audit,
        byTag: audit.byTag.slice(0, top),
        repeated: audit.repeated.slice(0, top),
      });
      return;
    }
    printAudit(file, audit, top);
  }
}
