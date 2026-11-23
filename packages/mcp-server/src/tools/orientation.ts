/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapSnapshot} from '@memlab/core';
import {computeHeapBudget} from '../heap-budget.js';
import {listSnapshots} from '../heap-state.js';
import {realmClasses, type RealmKind} from '../realm-tags.js';
import {formatBytes, formatNumber} from '../utils.js';
import {shapeClusters, shapeText} from './shape-clusters.js';

/** Past this many nodes the orientation pass is left to `memlab_sweep`. */
export const ORIENT_MAX_NODES = 20_000_000;

const pct = (n: number, total: number): string =>
  total > 0 ? `${((n / total) * 100).toFixed(0)}%` : '—';

/**
 * What a first look at a snapshot needs, in the load response: what the heap
 * is made of, which realms it holds, and its largest bottom-up populations.
 * These used to be three or four separate calls before any question was asked.
 */
export function orientationLines(snapshot: IHeapSnapshot): string[] {
  const b = computeHeapBudget(snapshot);
  const parts = [
    `bundle source ${formatBytes(b.bundle)}`,
    `code ${formatBytes(b.code)}`,
    ...(b.devOnly > 0 ? [`dev/automation-only ${formatBytes(b.devOnly)}`] : []),
    ...(b.artifact > 0 ? [`known artifacts ${formatBytes(b.artifact)}`] : []),
    ...(b.otherRealms > 0
      ? [`other realms ${formatBytes(b.otherRealms)}`]
      : []),
  ];
  const lines = [
    '## Orientation',
    '',
    `- **App:** ${formatBytes(b.app)} of ${formatBytes(b.total)} (${pct(b.app, b.total)}) is application memory; the rest is ${parts.join(', ')}. Quote the app figure, not the total.`,
  ];
  const realms = realmClasses(snapshot);
  if (realms != null) {
    const byKind = new Map<RealmKind, number>();
    for (const k of realms.kindByOrdinal.values()) {
      if (k !== 'page') byKind.set(k, (byKind.get(k) ?? 0) + 1);
    }
    const others = [...byKind.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([k, n]) => `${formatNumber(n)} ${k}`)
      .join(', ');
    lines.push(
      `- **Realms:** the page${realms.pageLabel ? ` (\`${realms.pageLabel}\`)` : ''}${others ? `, plus ${others}` : ''}. Objects those other realms own are not the page's: \`memlab_get_node\` and \`memlab_retainer_trace\` say so.`,
    );
  }
  const shapes = shapeClusters(snapshot, {candidates: 20}).slice(0, 3);
  if (shapes.length > 0) {
    lines.push(
      `- **Largest populations by shape** (what cutting every instance frees): ${shapes
        .map(
          c =>
            `\`${shapeText(c.cls, c.props, 48)}\` ×${formatNumber(c.count)} → ${formatBytes(c.frees)}`,
        )
        .join('; ')}.`,
    );
  }
  const resident = listSnapshots().filter(m => !m.light).length;
  if (resident > 1) {
    lines.push(
      `- **${formatNumber(resident)} snapshots resident:** \`memlab_sweep\` compares them (section 11), and \`memlab_diff_snapshots\` ranks the shapes that grew by count.`,
    );
  }
  return lines;
}

/** The next-step menu when the orientation above already answered "what is this?". */
export function shortNextStepMenu(): string[] {
  return [
    '**Next:**',
    '- Every first-pass lead in one call → `memlab_sweep` (with `paths`, or several resident, it compares rungs)',
    '- What grew across rungs → `memlab_collection_diff`, `memlab_diff_snapshots`, `memlab_duplicate_subscriptions`',
    '- Is X a leak / what does cutting it free → `memlab_hypothesis`, `memlab_what_if`, `memlab_growth_check`',
    '- Anything else → `memlab_tools` lists every tool by the question it answers',
  ];
}
