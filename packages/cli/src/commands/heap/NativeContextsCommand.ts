/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {
  CLIOptions,
  CommandOptionExample,
  IHeapSnapshot,
} from '@memlab/core';
import type {ClassRow} from '../../lib/heap/ClassHistogram';
import type {
  NativeContextAttribution,
  NativeContextInfo,
} from '../../lib/heap/NativeContexts';

import {BaseOption, info, utils} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import SnapshotFileOption from '../../options/heap/SnapshotFileOption';
import OutputFormatOption from '../../options/heap/OutputFormatOption';
import TopOption from '../../options/heap/TopOption';
import {getClassKey} from '../../lib/heap/ClassHistogram';
import {
  attributeNativeContexts,
  selectContexts,
} from '../../lib/heap/NativeContexts';
import {
  clipText,
  formatBytes,
  formatCount,
  formatPercent,
  isJsonOutput,
  renderTable,
  writeJsonOutput,
} from '../../lib/heap/HeapReportFormat';

// classes listed for each detached realm
const DETACHED_TOP_CLASSES = 5;
const MAX_DETACHED_BREAKDOWNS = 3;

/** The largest classes, by self size, among the objects one realm owns. */
function ownedClasses(
  snapshot: IHeapSnapshot,
  attribution: NativeContextAttribution,
  context: NativeContextInfo,
  limit: number,
): ClassRow[] {
  const rows = new Map<string, ClassRow>();
  snapshot.nodes.forEach(node => {
    if (attribution.owner[node.nodeIndex] !== context.ordinal) {
      return;
    }
    const key = getClassKey(node);
    const id = `${key.type}\u0000${key.name}`;
    const row = rows.get(id) ?? {...key, count: 0, selfSize: 0};
    row.count++;
    row.selfSize += node.self_size;
    rows.set(id, row);
  });
  return [...rows.values()]
    .sort((a, b) => b.selfSize - a.selfSize || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function printReport(
  file: string,
  a: NativeContextAttribution,
  detachedClasses: Map<number, ClassRow[]>,
  top: number,
): void {
  const owned = a.contexts.reduce((sum, c) => sum + c.ownedSize, 0);
  const total = owned + a.sharedSize + a.unattributedSize;
  info.topLevel(`Snapshot  ${file}`);
  info.lowLevel(
    `  ${formatCount(a.contexts.length)} native ` +
      `${a.contexts.length === 1 ? 'context (realm)' : 'contexts (realms)'}; ` +
      `${formatPercent(owned, total)} of ${formatBytes(total)} is owned by one realm`,
  );
  const rows = selectContexts(a.contexts, top).map(c => [
    `@${c.id}`,
    clipText(c.label || '(no URL)', 70),
    c.detached ? 'yes' : '',
    formatBytes(c.ownedSize),
    formatPercent(c.ownedSize, total),
    formatCount(c.ownedCount),
  ]);
  rows.push(
    [
      '',
      '(shared by several realms)',
      '',
      formatBytes(a.sharedSize),
      formatPercent(a.sharedSize, total),
      formatCount(a.sharedCount),
    ],
    [
      '',
      '(no realm: engine internals)',
      '',
      formatBytes(a.unattributedSize),
      formatPercent(a.unattributedSize, total),
      formatCount(a.unattributedCount),
    ],
  );
  renderTable(
    ['context', 'realm', 'detached', 'owned', 'share', 'objects'],
    rows,
    ['left', 'left', 'left', 'right', 'right', 'right'],
  ).forEach(line => info.topLevel(line));

  for (const [id, classes] of detachedClasses) {
    info.topLevel('');
    info.topLevel(`Detached context @${id} owns most:`);
    renderTable(
      ['class', 'type', 'count', 'self size'],
      classes.map(r => [
        clipText(r.name, 60),
        r.type,
        formatCount(r.count),
        formatBytes(r.selfSize),
      ]),
      ['left', 'left', 'right', 'right'],
    ).forEach(line => info.topLevel(line));
  }
  const [firstDetached] = detachedClasses.keys();
  if (firstDetached != null) {
    info.warning(
      'A detached context is a window or iframe that was removed but is ' +
        'still reachable. To see what holds it: memlab trace --snapshot ' +
        `${file} --node-id ${firstDetached}`,
    );
  }
}

export default class NativeContextsCommand extends BaseCommand {
  getCommandName(): string {
    return 'native-contexts';
  }

  getDescription(): string {
    return (
      'split a heap snapshot by JavaScript realm (page, iframes, extension ' +
      'worlds, detached windows, Node.js vm contexts) and report the memory ' +
      'each one owns'
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
      new TopOption(),
      new OutputFormatOption(),
    ];
  }

  async run(options: CLIOptions): Promise<void> {
    const top = TopOption.getValue(options.cliArgs);
    const file = utils.getSingleSnapshotFileForAnalysis();
    const snapshot = await utils.getSnapshotFromFile(file, {});
    const attribution = attributeNativeContexts(snapshot);
    const detachedClasses = new Map<number, ClassRow[]>();
    for (const context of attribution.contexts) {
      if (context.detached && detachedClasses.size < MAX_DETACHED_BREAKDOWNS) {
        detachedClasses.set(
          context.id,
          ownedClasses(snapshot, attribution, context, DETACHED_TOP_CLASSES),
        );
      }
    }
    if (isJsonOutput()) {
      writeJsonOutput({
        file,
        contextCount: attribution.contexts.length,
        contexts: selectContexts(attribution.contexts, top).map(c => ({
          id: c.id,
          label: c.label,
          detached: c.detached,
          ownedSize: c.ownedSize,
          ownedCount: c.ownedCount,
          ownedClasses: detachedClasses.get(c.id),
        })),
        shared: {size: attribution.sharedSize, count: attribution.sharedCount},
        unattributed: {
          size: attribution.unattributedSize,
          count: attribution.unattributedCount,
        },
      });
      return;
    }
    printReport(file, attribution, detachedClasses, top);
  }
}
