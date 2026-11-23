/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {getSnapshotMetadata, listSnapshots} from '../heap-state.js';
import {
  isolateOf,
  isolateSample,
  type IsolateSample,
} from '../isolate-identity.js';
import {resolveRungs, withSnapshotAt} from '../snapshot-borrow.js';
import {
  collectBackingSlots,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  pathsHeader,
  toolResult,
} from '../utils.js';
import {countEntries} from './collection-trend.js';
import {resolveStableKey, stableKeyOf} from './module-attribution.js';

/** Holders whose size is an entry count; any other object is sized by bytes. */
const COLLECTIONS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'Array']);

/** Members compared by id: enough to tell turnover from a frozen buffer. */
const MAX_MEMBERS = 50_000;

export interface RungMeasure {
  label: string;
  found: 'id' | 'path' | null;
  /** Against the newest rung; ids match objects only within one isolate. */
  isolate?: 'same' | 'other' | 'unknown';
  entries: number | null;
  retained: number;
  members: Set<number>;
}

export type GrowthVerdict =
  'grows' | 'frozen' | 'turns over' | 'shrinks' | 'flat' | 'not comparable';

/** The ids an object points at directly: its entries or its fields. */
function memberIds(node: IHeapNode): Set<number> {
  if (COLLECTIONS.has(node.name) && node.name !== 'Array') {
    // Browser captures type the backing-store slots `internal`.
    return new Set(
      collectBackingSlots(node)
        .slice(0, MAX_MEMBERS)
        .map(s => s.node.id),
    );
  }
  const out = new Set<number>();
  const visit = (n: IHeapNode) => {
    for (const e of n.references) {
      if (out.size >= MAX_MEMBERS) return;
      if (e.type === 'weak' || e.type === 'shortcut') continue;
      const k = String(e.name_or_index);
      if (k === '__proto__' || k === 'map') continue;
      // Collections keep entries in a backing store one hop down.
      if (e.type === 'internal' && (k === 'table' || k === 'elements')) {
        visit(e.toNode);
        continue;
      }
      if (e.type === 'internal' || e.type === 'hidden') continue;
      out.add(e.toNode.id);
    }
  };
  visit(node);
  return out;
}

/** The share of `first`'s members that `later` still holds. */
function kept(first: Set<number>, later: Set<number>): number {
  if (first.size === 0) return 1;
  let shared = 0;
  for (const id of first) if (later.has(id)) shared++;
  return shared / first.size;
}

/**
 * The rung membership is measured from: the first same-session rung where the
 * holder was found, when at least two such rungs exist; ids on a rung from
 * another session name other objects.
 */
export function membersBase(rungs: RungMeasure[]): RungMeasure | null {
  const same = rungs.filter(r => r.found != null && r.isolate !== 'other');
  return same.length >= 2 ? same[0] : null;
}

/**
 * What the measurements support. Sizes within 10% are "the same size"; the
 * share of first-rung members still present on the last rung tells a frozen
 * buffer (≥ 95% kept) from a bounded queue whose entries are replaced (< 50%).
 * Members are compared only between rungs of one session.
 */
export function growthVerdict(
  rungs: RungMeasure[],
  hasKey = true,
): {
  verdict: GrowthVerdict;
  why: string;
} {
  const seen = rungs.filter(r => r.found != null);
  if (seen.length < 2) {
    const onlyLast = rungs.length >= 2 && rungs[rungs.length - 1].found != null;
    const matchable =
      hasKey || rungs.slice(0, -1).every(r => r.isolate === 'same');
    return {
      verdict: 'not comparable',
      why: !onlyLast
        ? 'the holder was found on fewer than two rungs, so growth cannot be observed'
        : matchable
          ? 'the holder is not on the earlier rungs (by id or module path): it was created since. Compare how many such holders each rung has with `memlab_collection_diff`'
          : 'the holder has no module path, and the earlier rungs may come from another session, where its id names a different object, so it cannot be found there. Compare how many such holders each rung has with `memlab_collection_diff`',
    };
  }
  const first = seen[0];
  const last = seen[seen.length - 1];
  const byEntries = seen.every(r => r.entries != null);
  const size = (r: RungMeasure) => (byEntries ? (r.entries ?? 0) : r.retained);
  const a = size(first);
  const b = size(last);
  const change = a === 0 ? (b === 0 ? 0 : Infinity) : (b - a) / a;
  const sameSession = seen.filter(r => r.isolate !== 'other');
  const base = membersBase(rungs);
  const keptShare = base != null ? kept(base.members, last.members) : null;
  const keptNote =
    base == null
      ? 'members not compared: the earlier rungs are from another session, where ids name other objects'
      : `${((keptShare ?? 0) * 100).toFixed(0)}% of ${base === first ? "the first rung's" : `${base.label}'s`} members are still held`;
  const monotonic = seen.every(
    (r, i) => i === 0 || size(r) >= size(seen[i - 1]),
  );
  const what = byEntries ? 'entries' : 'retained bytes';
  if (change > 0.1 && b - a >= 2) {
    return {
      verdict: 'grows',
      why: `${what} ${formatNumber(a)} → ${formatNumber(b)}${monotonic ? ', rising at every rung' : ', not at every rung'}; ${keptNote}`,
    };
  }
  if (change < -0.1) {
    return {
      verdict: 'shrinks',
      why: `${what} ${formatNumber(a)} → ${formatNumber(b)}: entries are removed`,
    };
  }
  const unchanged = (r: RungMeasure) =>
    kept(first.members, r.members) >= 0.95 &&
    r.members.size <= first.members.size * 1.05 &&
    Math.abs(r.retained - first.retained) <= 0.02 * Math.max(1, first.retained);
  if (
    keptShare != null &&
    sameSession.length === seen.length &&
    first.members.size > 0 &&
    seen.every(unchanged)
  ) {
    return {
      verdict: 'frozen',
      why: `the same members (${(keptShare * 100).toFixed(0)}% kept) and the same retained size on every rung: nothing is appended`,
    };
  }
  if (keptShare != null && keptShare < 0.5) {
    return {
      verdict: 'turns over',
      why: `about the same size, but only ${keptNote}: entries are replaced, so it is bounded`,
    };
  }
  const peak = seen.reduce((p, r) => (size(r) > size(p) ? r : p));
  const peaked =
    size(peak) > Math.max(a, b) * 1.1
      ? `, but ${formatNumber(size(peak))} on ${peak.label} between them`
      : '';
  return {
    verdict: 'flat',
    why: `${what} within 10% (${formatNumber(a)} → ${formatNumber(b)})${peaked}, ${keptShare != null ? `${(keptShare * 100).toFixed(0)}% of members kept` : keptNote}`,
  };
}

const CLAIM: Record<GrowthVerdict, string> = {
  grows:
    '"Grows" is supported. Check it scales with the interaction (`memlab_collection_trend` with `cycles`) before calling it unbounded.',
  frozen:
    'Do not write "grows", "keeps appending" or "unbounded": the holder did not change. It can still be waste: size it with `memlab_what_if`.',
  'turns over':
    'Do not write "grows" or "never removed": entries are removed and replaced. Report a standing cost only if its size matters.',
  shrinks: 'Do not write "grows" or "never removed".',
  flat: 'Do not write "grows" from this ladder.',
  'not comparable': 'No growth claim: say "holds N now" instead.',
};

function measure(
  snap: IHeapSnapshot,
  label: string,
  id: number,
  name: string,
  key: string | null,
  newest: IsolateSample | null,
): RungMeasure {
  const isolate = newest == null ? 'same' : isolateOf(snap, newest);
  let node = isolate === 'other' ? null : snap.getNodeById(id);
  let found: RungMeasure['found'] =
    node != null && node.name === name ? 'id' : null;
  if (found == null && key != null) {
    node = resolveStableKey(snap, key);
    found = node != null && node.name === name ? 'path' : null;
  }
  if (found == null || node == null) {
    return {
      label,
      found: null,
      isolate,
      entries: null,
      retained: 0,
      members: new Set(),
    };
  }
  return {
    label,
    found,
    isolate,
    entries:
      COLLECTIONS.has(node.name) || node.type === 'array'
        ? countEntries(node)
        : null,
    retained: node.retainedSize,
    members: memberIds(node),
  };
}

export function registerGrowthCheck(server: McpServer): void {
  server.tool(
    'memlab_growth_check',
    "Check a GROWTH claim about one holder before writing it: finds the same object on every rung (by id, else by its module path) and reports entries, retained size and how many of the first rung's members it still holds, then a verdict — grows, frozen (same members and size: nothing appended), turns over (same size, members replaced: bounded), shrinks, flat, or not comparable (one snapshot). " +
      'Words like "grows", "unbounded", "keeps appending" and "never removed" need "grows" here. A single snapshot cannot show growth.',
    {
      node_id: z
        .number()
        .describe(
          'The holder (a Map, Set, array or object) in the newest snapshot.',
        ),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Snapshot paths or handles, OLDEST FIRST, the one holding `node_id` last. Default: the resident snapshots in load order, the active one last.',
        ),
    },
    async ({node_id, paths}) => {
      try {
        let rungPaths: string[];
        let labels: string[];
        if (paths != null && paths.length > 0) {
          const {rungs} = resolveRungs(paths);
          rungPaths = rungs.map(r => r.localPath);
          labels = rungs.map(r => r.label);
        } else {
          const active = getSnapshotMetadata();
          const others = listSnapshots().filter(
            m => m.handle !== active?.handle && !m.light,
          );
          const all = [...others, ...(active != null ? [active] : [])];
          rungPaths = all.map(m => m.filePath);
          labels = all.map(m => m.handle);
        }
        if (rungPaths.length === 0) {
          return errorResult(
            new Error('No snapshot loaded. Use memlab_load_snapshot first.'),
          );
        }
        const newestPath = rungPaths[rungPaths.length - 1];
        const newest = await withSnapshotAt(newestPath, s => {
          const n = s.getNodeById(node_id);
          if (n == null) return null;
          const key = stableKeyOf(s, n);
          return {
            target: {name: n.name, key},
            sample: isolateSample(s),
            rung: measure(
              s,
              labels[labels.length - 1],
              node_id,
              n.name,
              key,
              null,
            ),
          };
        });
        if (newest == null) {
          return errorResult(
            new Error(
              `@${node_id} is not in the newest snapshot (${labels[labels.length - 1]}).`,
            ),
          );
        }
        const {target, sample} = newest;
        const rungs: RungMeasure[] = [];
        for (const [i, p] of rungPaths.slice(0, -1).entries()) {
          rungs.push(
            await withSnapshotAt(p, s =>
              measure(s, labels[i], node_id, target.name, target.key, sample),
            ),
          );
        }
        rungs.push(newest.rung);
        const base = membersBase(rungs);
        const {verdict, why} = growthVerdict(rungs, target.key != null);
        const lines = [
          `## Growth check: @${node_id} ${target.name}${target.key != null ? ` (\`${target.key}\`)` : ''}`,
          '',
          markdownTable(
            [
              'Rung',
              'Found by',
              'Entries',
              'Retained',
              'Members kept from first',
            ],
            rungs.map(r => [
              r.label,
              r.found != null
                ? `${r.found}${r.isolate === 'other' ? ' (other session)' : ''}`
                : r.isolate === 'other'
                  ? 'not found (other session)'
                  : 'not found',
              r.entries != null ? formatNumber(r.entries) : '—',
              r.found != null ? formatBytes(r.retained) : '—',
              r.found != null && base != null && r.isolate !== 'other'
                ? `${(kept(base.members, r.members) * 100).toFixed(0)}%`
                : '—',
            ]),
            new Set([2, 3, 4]),
          ),
          '',
          `**Verdict: ${verdict}** — ${why}.`,
          '',
          CLAIM[verdict],
        ];
        return toolResult(lines.join('\n'), pathsHeader(labels));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
