/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import fs from 'fs';
import path from 'path';
import {readSidecarAsync} from './snapshot-index.js';

/**
 * A growth family an earlier round already explained, keyed by the property
 * shape of its plain objects so that it matches on a minified build.
 *
 * Families file format: `{"families": [KnownFamily, ...]}`.
 */
export interface KnownFamily {
  id: string;
  label: string;
  /** Plain objects having ALL of the props of any one of these shapes. */
  shapes: string[][];
  /** e.g. "known", "fixed", "bounded". */
  status?: string;
  /** Where it was found or tracked (a round, an issue, a doc). */
  finding?: string;
  /** The retainer the family was traced to. */
  retainer?: string;
}

export interface FamilyRow {
  family: KnownFamily;
  /** Matching plain objects per rung; null where the rung has no index. */
  counts: Array<number | null>;
}

export function loadFamilies(file: string): KnownFamily[] {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    families?: unknown;
  };
  if (!Array.isArray(raw.families)) {
    throw new Error(`${file}: expected {"families": [...]}`);
  }
  return raw.families.map((f: unknown, i: number) => {
    const fam = f as Partial<KnownFamily>;
    if (
      typeof fam.id !== 'string' ||
      typeof fam.label !== 'string' ||
      !Array.isArray(fam.shapes) ||
      fam.shapes.length === 0 ||
      !fam.shapes.every(
        s => Array.isArray(s) && s.every(p => typeof p === 'string'),
      )
    ) {
      throw new Error(
        `${file}: family ${i} needs a string id and label and a non-empty shapes list of string arrays`,
      );
    }
    return fam as KnownFamily;
  });
}

/** Split a sidecar shape key (`joinShapeKey`) back into property names. */
function splitShapeKey(key: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < key.length; i++) {
    const ch = key[i];
    if (ch === '\\' && i + 1 < key.length) {
      cur += key[++i];
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Count each family's plain objects per rung from the rung sidecars, which
 * already hold a count per property shape: no graph is loaded. An object is
 * counted once per family even when it matches several of its shapes.
 */
export async function familyCounts(
  paths: readonly string[],
  families: readonly KnownFamily[],
): Promise<FamilyRow[]> {
  const perRung = await Promise.all(
    paths.map(async p => {
      const index = await readSidecarAsync(p);
      if (index == null) {
        return null;
      }
      const shapes = Object.entries(index.objectShapes).map(
        ([key, [count]]) => ({props: new Set(splitShapeKey(key)), count}),
      );
      return families.map(f =>
        shapes.reduce(
          (n, s) =>
            f.shapes.some(want => want.every(p => s.props.has(p)))
              ? n + s.count
              : n,
          0,
        ),
      );
    }),
  );
  return families.map((family, i) => ({
    family,
    counts: perRung.map(r => (r == null ? null : r[i])),
  }));
}

/** The plain objects of every shape, per rung: what the families explain. */
export async function plainObjectTotals(
  paths: readonly string[],
): Promise<Array<number | null>> {
  return Promise.all(
    paths.map(async p => {
      const index = await readSidecarAsync(p);
      return index == null
        ? null
        : Object.values(index.objectShapes).reduce((n, [c]) => n + c, 0);
    }),
  );
}

export function familiesSection(
  file: string,
  rows: FamilyRow[],
  totals: Array<number | null>,
  cycles: number | undefined,
): string[] {
  const delta = (c: Array<number | null>) => {
    const first = c[0];
    const last = c[c.length - 1];
    return first == null || last == null ? null : last - first;
  };
  const lines = [
    `### Known families (${path.basename(file)})`,
    '',
    '| Family | ' +
      rows[0].counts.map((_, i) => `#${i + 1}`).join(' | ') +
      ' | Δ | Δ/cycle | Status | Finding |',
    '|---|' + rows[0].counts.map(() => '--:').join('|') + '|--:|--:|---|---|',
  ];
  let explained = 0;
  for (const row of rows) {
    const d = delta(row.counts);
    if (d != null && d > 0) explained += d;
    lines.push(
      `| ${row.family.label} (\`${row.family.id}\`) | ` +
        row.counts
          .map(c => (c == null ? '?' : c.toLocaleString()))
          .join(' | ') +
        ` | ${d == null ? '?' : (d >= 0 ? '+' : '') + d.toLocaleString()}` +
        ` | ${d == null || cycles == null || cycles <= 0 ? '' : (d / cycles).toFixed(2)}` +
        ` | ${row.family.status ?? ''} | ${row.family.finding ?? ''} |`,
    );
  }
  const total = delta(totals);
  lines.push('');
  if (total != null && total > 0) {
    const rest = Math.max(0, total - explained);
    lines.push(
      `Known families explain ${explained.toLocaleString()} of the ${total.toLocaleString()} new plain objects (${((100 * Math.min(explained, total)) / total).toFixed(0)}%). ` +
        (rest > 0
          ? `**${rest.toLocaleString()} are NEW**: start there, not with the known rows.`
          : 'Nothing new among plain objects.'),
      '',
    );
  }
  return lines;
}
