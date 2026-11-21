/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapEdge, IHeapNode, IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {
  getMetadataByHandle,
  getSnapshot,
  getSnapshotMetadata,
  listSnapshots,
} from '../heap-state.js';
import {cachedPathLabeler} from '../heap-families.js';
import {recordSweepLeads, SWEEP_SECTION as SEC} from '../lead-registry.js';
import {getSlotBytes} from '../heap-shapes.js';
import {resolveRungs, withSnapshotAt} from '../snapshot-borrow.js';
import {stringFamilyCensus} from '../string-families.js';
import {
  envLabelOf,
  errorResult,
  filterLargestObjects,
  formatBytes,
  formatNumber,
  heldByLabel,
  isNodeWorthInspecting,
  markdownTable,
  pathsHeader,
  sanitizeForTable,
  SubtreeCollapser,
  toolResult,
  truncateNodeName,
} from '../utils.js';
import {asyncCensusFacts, asyncFlagLines} from './async-census.js';
import {diagnosticBuffersSweepSection} from './diagnostic-buffers.js';
import {
  DEAD_FLAG,
  findCollections,
  formatSplit,
  splitOf,
} from './collection-census.js';
import {loadSnapshotByPath, productionReach} from './explain-delta.js';
import {
  type BufferProbe,
  loadBufferProbes,
  moduleRegistryIds,
  probeBuffers,
} from './framework-buffers.js';
import {fiberCensusSweepSection} from './fiber-census.js';
import {finishedStateSweepSection} from './finished-state.js';
import {renderGrowthAnchors} from './growth-anchors.js';
import {cachedModuleScopes} from './module-attribution.js';
import {nodeServerFlagLines} from './node-server.js';
import {nodeServerPinsSweepSection} from './node-server-pins.js';
import {formatObjectGrowth, ObjectGrowthTracker} from './object-growth.js';
import {
  reactStaleRefsSweepSection,
  type StaleReactLead,
} from './react-stale-refs.js';
import type {NumberRow} from './residual.js';

/**
 * `memlab_sweep`: the first-pass sweep the best hand-written investigations
 * ran, as one call. Every section is an existing building block; this file
 * only picks their leads, caps them and prints them in one place, so a run
 * that skips a step no longer misses what that step finds.
 */

// Rows per section by default; `detail: "full"` doubles them.
const CAPS = {
  top: 30,
  dead: 10,
  big: 5,
  strings: 6,
  buffers: 8,
  holders: 5,
  growth: 10,
  anchors: 8,
  cuts: 10,
  extra: 5,
  budget: 14_000,
};
type Caps = typeof CAPS;
const capsFor = (detail: 'leads' | 'full'): Caps =>
  detail === 'leads'
    ? CAPS
    : (Object.fromEntries(
        Object.entries(CAPS).map(([k, v]) => [
          k,
          k === 'budget' ? 34_000 : v * 2,
        ]),
      ) as Caps);

/** One lead the residual call can cut: node ids, or a `Class.prop` edge. */
export interface Lead {
  label: string;
  bytes: number;
  /** The section that found it. */
  section: number;
  ids?: number[];
  edge?: string;
}

const isText = (type: string) => type === 'string' || type.endsWith(' string');
const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;
/** A holder label, clipped in the middle: a module path ends in its name. */
const holderOf = (n: IHeapNode) => {
  const l = heldByLabel(n, 200);
  return l.length > 48 ? `${l.slice(0, 14)}…${l.slice(-33)}` : l;
};
const tick = (s: string) => `\`${sanitizeForTable(s).replace(/`/g, "'")}\``;

/**
 * Technique C2: whether a node hangs directly off the GC root, the global
 * object or a module scope, which is where state that never goes away lives.
 */
export function directHolderMark(
  dom: IHeapNode | null,
  moduleOf: (id: number) => string | undefined,
): string {
  if (dom == null || dom.id <= 3 || dom.type === 'synthetic') return 'root';
  if (/^Window\b|GlobalScope|JSGlobal/.test(dom.name)) return 'global';
  const mod = moduleOf(dom.id);
  if (mod != null) return `module ${clip(mod, 28)}`;
  // A Node.js `require.cache` record.
  if (dom.name === 'Module' && dom.type === 'object') return 'module';
  return '';
}

const TOP_EXCLUDED = new Set(['array', 'code', 'synthetic']);
// String text held outside the heap, and Blink's unnamed internal nodes:
// neither has a holder to name.
const TOP_EXCLUDED_NAMES = new Set([
  'system / ExternalStringData',
  'InternalNode',
]);

function topRetained(s: IHeapSnapshot, caps: Caps, leads: Lead[]): string[] {
  const cands = filterLargestObjects(
    s,
    // Natives and hidden nodes too (a SharedArrayBuffer, a Wasm module);
    // backing arrays, code and text stay out.
    n =>
      isNodeWorthInspecting(n, {allowBlockedTypes: true}) &&
      !TOP_EXCLUDED.has(n.type) &&
      !isText(n.type) &&
      !TOP_EXCLUDED_NAMES.has(n.name),
    caps.top * 6 + 30,
  );
  const collapser = new SubtreeCollapser();
  for (const c of cands) collapser.push(c);
  const scopes = cachedModuleScopes(s);
  const registries = moduleRegistryIds(s);
  const total = s.nodes.get(0)?.retainedSize ?? 0;
  const rows = collapser.rows.slice(0, caps.top).map(({node}, i) => {
    const holder = holderOf(node);
    const mark = directHolderMark(node.dominatorNode ?? null, id =>
      scopes.get(id),
    );
    // A module registry, or a row holding a tenth of the heap, is the app
    // itself, not a cut.
    if (node.retainedSize < total * 0.1 && !registries.has(node.id)) {
      leads.push({
        label: holder,
        bytes: node.retainedSize,
        ids: [node.id],
        section: SEC.top,
      });
    }
    return [
      String(i + 1),
      `@${node.id}`,
      sanitizeForTable(truncateNodeName(node.name, node.type, 0, 40)),
      formatBytes(node.retainedSize),
      sanitizeForTable(holder),
      mark,
    ];
  });
  if (rows.length === 0) return [];
  return [
    `## 1. Top retained with holder (${rows.length}; strings and code excluded) → \`memlab_retainer_trace\` / \`memlab_dominator_subtree\``,
    '',
    markdownTable(
      ['#', 'Node', 'Name', 'Retained', 'Held by', 'Held directly by'],
      rows,
      new Set([3]),
    ),
    '',
  ];
}

// A dead share in a small collection is not worth a line.
const DEAD_MIN_BYTES = 32 * 1024;

function collections(s: IHeapSnapshot, caps: Caps, leads: Lead[]): string[] {
  const rows = findCollections(s, 500).sort(
    (a, b) => b.retained - a.retained || b.entries - a.entries,
  );
  if (rows.length === 0) return [];
  const slot = getSlotBytes(s);
  const labeler = cachedPathLabeler(s);
  const dead: string[] = [];
  const big: string[] = [];
  for (const [i, r] of rows.entries()) {
    if (dead.length >= caps.dead && i >= caps.big) break;
    const split = splitOf(r.node, slot);
    const share = split.dead / Math.max(1, split.examined);
    const flagged =
      share >= DEAD_FLAG &&
      r.retained >= DEAD_MIN_BYTES &&
      dead.length < caps.dead;
    if (!flagged && i >= caps.big) continue;
    const holder = holderOf(r.node);
    const path = labeler.labelOf(r.node);
    const drill =
      r.node.name === 'Array' ? 'memlab_array_group_by' : 'memlab_map_entries';
    const why = flagged
      ? `**dead ${Math.round(share * 100)}%**: ${formatSplit(split)}`
      : split.shapes.map(x => `${x.shape} ×${x.n}`).join(', ');
    const line =
      `- @${r.node.id} ${r.node.name} ${tick(holder)} (${clip(path, 40)}) ${formatNumber(r.entries)} entries, ` +
      `${formatBytes(r.retained)}; ${why} → \`${drill}\``;
    (flagged ? dead : big).push(line);
    if (flagged) {
      leads.push({
        label: holder,
        bytes: r.retained,
        ids: [r.node.id],
        section: SEC.dead,
      });
    }
  }
  return [
    `## 2. Collections (${formatNumber(rows.length)} with ≥ 500 entries: ${dead.length} at least ${DEAD_FLAG * 100}% dead, then the largest) → \`memlab_collection_census\``,
    '',
    ...dead,
    ...big,
    '',
  ];
}

function strings(s: IHeapSnapshot, caps: Caps, leads: Lead[]): string[] {
  const census = stringFamilyCensus(s, {limit: caps.strings});
  if (census.families.length === 0) return [];
  const lines = census.families.map(f => {
    const holders = f.holders
      .map(h => `${tick(h.label)} ×${formatNumber(h.count)}`)
      .join('; ');
    // `Owner › Object.prop`: the last hop is the edge to cut.
    const edge = f.holders[0]?.label.split(' › ').pop() ?? '';
    // A few large strings are cut by id; a family by the edge holding it.
    if (f.count <= 50 || /^[\w$]+\.[\w$]+$/.test(edge)) {
      leads.push({
        label: `strings ${f.count <= 50 ? clip(f.key, 24) : edge}`,
        bytes: f.bytes,
        section: SEC.strings,
        ...(f.count <= 50 ? {ids: [f.exampleId]} : {edge}),
      });
    }
    return (
      `- ${tick(clip(f.key, 30))} ×${formatNumber(f.count)}, ${formatBytes(f.bytes)}; ` +
      `largest @${f.exampleId}; held by ${holders || '-'}` +
      `${f.sampled < f.count ? ` (of ${formatNumber(f.sampled)} sampled)` : ''}`
    );
  });
  return [
    `## 3. String families (≥ ${formatBytes(census.threshold)}, digits → #, script source excluded) → \`memlab_get_referrers\` on the example`,
    '',
    ...lines,
    '',
  ];
}

const BUFFER_DRILL: Record<string, string> = {
  'per-call keys': 'memlab_framework_buffers',
  'cancelled scheduler tasks': 'memlab_async_census',
  'cancelled-in-place listeners': 'memlab_array_group_by',
  'oversized log': 'memlab_array_group_by',
};

function buffers(s: IHeapSnapshot, caps: Caps, leads: Lead[]): string[] {
  let probes: BufferProbe[] = [];
  try {
    ({probes} = loadBufferProbes());
  } catch {
    // A bad probe file costs the app-specific rows, not the generic ones.
  }
  // A module registry shares the per-call keys of the timing map it indexes;
  // the timing map row is the lead.
  const registries = moduleRegistryIds(s);
  const rows = probeBuffers(s, probes)
    .filter(r => r.flag != null && (r.id == null || !registries.has(r.id)))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, caps.buffers);
  if (rows.length === 0) return [];
  return [
    '## 4. Framework buffers (flagged rows only)',
    '',
    ...rows.map(r => {
      if (r.id != null)
        leads.push({
          label: `${r.flag}: ${r.where.replace(/[()]/g, '').split(/[.: ]/).pop()}`,
          bytes: r.bytes,
          ids: [r.id],
          section: SEC.buffers,
        });
      const entries =
        r.entries != null ? `${formatNumber(r.entries)} entries, ` : '';
      return (
        `- ${r.id != null ? `@${r.id} ` : ''}**${r.flag}** ${tick(clip(r.where, 60))} ${entries}` +
        `${formatBytes(r.bytes)}: ${r.note} → \`${BUFFER_DRILL[r.flag ?? ''] ?? 'memlab_framework_buffers'}\``
      );
    }),
    '',
  ];
}

/** Class key for technique C11, or null for engine internals and text. */
function classKey(n: IHeapNode): string | null {
  if (n.id <= 3) return null;
  if (n.type === 'number') return '(number)';
  if (n.type !== 'object' && n.type !== 'closure') return null;
  return n.name.startsWith('system /') || n.name === '' ? null : n.name;
}

/** The edge that holds a node: from its dominator, else the first strong one. */
function holdingEdge(n: IHeapNode): IHeapEdge | null {
  const dom = n.dominatorNode;
  let any: IHeapEdge | null = null;
  for (const e of n.referrers) {
    if (e.type === 'weak' || e.type === 'shortcut') continue;
    if (e.fromNode.type === 'synthetic') continue;
    if (dom != null && e.fromNode.id === dom.id) return e;
    any ??= e;
  }
  return any;
}

const HOLDER_SAMPLE = 1_000_000;

/**
 * Fold the fields of one holder class that hold about equally many values
 * (same count to 2 significant digits): one record type's numeric fields,
 * such as a profiling build's 4 timing doubles per fiber. Counts are summed.
 */
export function foldFields(
  rows: NumberRow[],
): Array<NumberRow & {props: string[]}> {
  const by = new Map<string, NumberRow & {props: string[]}>();
  for (const r of rows) {
    const key = `${r.cls}\u0000${Number(r.count.toPrecision(2))}`;
    const m = by.get(key);
    if (m == null) by.set(key, {...r, props: [r.prop]});
    else {
      m.props.push(r.prop);
      m.count += r.count;
      m.bytes += r.bytes;
    }
  }
  return [...by.values()].sort((a, b) => b.bytes - a.bytes);
}

/** Technique C11: the largest class by self size, grouped by holder `Class.edge`. */
function classByHolder(s: IHeapSnapshot, caps: Caps): string[] {
  const bySelf = new Map<string, {count: number; self: number}>();
  s.nodes.forEach(n => {
    const k = classKey(n);
    if (k == null) return;
    const c = bySelf.get(k);
    if (c == null) bySelf.set(k, {count: 1, self: n.self_size});
    else {
      c.count++;
      c.self += n.self_size;
    }
  });
  const ranked = [...bySelf.entries()].sort((a, b) => b[1].self - a[1].self);
  if (ranked.length === 0) return [];
  // The largest class, and heap numbers too when they are big: boxed doubles
  // on one field of every instance hide under every class histogram.
  const picks = [ranked[0]];
  const num = bySelf.get('(number)');
  if (ranked[0][0] !== '(number)' && num != null && num.self >= 1024 * 1024) {
    picks.push(['(number)', num]);
  }
  const groups = new Map<string, Map<string, NumberRow>>();
  const stride = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const [k, v] of picks) {
    groups.set(k, new Map());
    // Heap numbers are not sampled: one record type's fields fold into one
    // row only when their counts are equal.
    const n = k === '(number)' ? 1 : Math.ceil(v.count / HOLDER_SAMPLE);
    stride.set(k, Math.max(1, n));
    seen.set(k, 0);
  }
  s.nodes.forEach(n => {
    const k = classKey(n);
    const g = k != null ? groups.get(k) : undefined;
    if (k == null || g == null) return;
    const i = seen.get(k) as number;
    seen.set(k, i + 1);
    if (i % (stride.get(k) as number) !== 0) return;
    const e = holdingEdge(n);
    if (e == null) return;
    const name = String(e.name_or_index);
    let from = e.fromNode;
    // An elements or table backing store: name the collection that owns it.
    if (from.type === 'array' || from.type === 'hidden') {
      const up = holdingEdge(from);
      if (up != null && up.type === 'internal') from = up.fromNode;
    }
    const indexed = e.type === 'element' || /^\d+$/.test(name);
    const cls =
      e.type === 'context' ? 'closure var' : from.name || `(${from.type})`;
    if (/^(system \/ |\()/.test(cls)) return;
    const prop = indexed ? '[]' : name;
    const key = `${cls}\u0000${prop}`;
    const r = g.get(key) ?? {cls, prop, count: 0, bytes: 0, sample: from.id};
    r.count++;
    r.bytes += n.self_size;
    g.set(key, r);
  });
  const out = [
    '## 9. Largest class by holder (by self size) → `memlab_property_distribution` / `memlab_find_nodes_by_class`',
    '',
  ];
  for (const [k, v] of picks) {
    const st = stride.get(k) as number;
    const all = [...(groups.get(k)?.values() ?? [])];
    // One record type's numeric fields fold into one row; other classes do
    // not, as unrelated holders of one instance each would fold too.
    const rows = (
      k === '(number)'
        ? foldFields(all.filter(r => r.count >= 10))
        : all
            .sort((a, b) => b.bytes - a.bytes)
            .map(r => ({...r, props: [r.prop]}))
    ).slice(0, caps.holders);
    out.push(
      `**${tick(clip(k, 40))}**: ${formatNumber(v.count)} instances, ${formatBytes(v.self)} self${st > 1 ? ` (holders of 1 in ${st})` : ''}`,
    );
    for (const r of rows) {
      const at =
        r.cls === 'closure var'
          ? `closure var ${r.props.join(', ')}`
          : r.props.length > 1
            ? `${r.cls}.{${r.props.join(', ')}}`
            : `${r.cls}.${r.prop}`;
      out.push(
        `- ${tick(clip(at.replace(/\.\[\]$/, '[]'), 70))} ×${formatNumber(r.count * st)}, ${formatBytes(r.bytes * st)}; e.g. holder @${r.sample}`,
      );
    }
  }
  out.push('');
  return out;
}

function asyncAndNode(s: IHeapSnapshot, env: string, leads: Lead[]): string[] {
  const flags = asyncFlagLines(s, asyncCensusFacts(s));
  for (const f of flags) {
    leads.push({
      label: f.label,
      bytes: f.bytes,
      ids: [f.id],
      section: SEC.async,
    });
  }
  const node = [
    ...nodeServerFlagLines(s, env).filter(l => l.startsWith('- ')),
    ...nodeServerPinsSweepSection(s, env),
  ];
  const lines = [...flags.map(f => `- ${f.line}`), ...node];
  return lines.length === 0
    ? []
    : ['## 10. Async and Node.js server', '', ...lines, ''];
}

/** Numbers a section built elsewhere: `## Title` -> `## 5. Title`. */
export function numbered(n: number, lines: string[]): string[] {
  if (lines.length === 0) return lines;
  const [head, ...rest] = lines;
  return [head.replace(/^## (?:\d+\. )?/, `## ${n}. `), ...rest];
}

/** Sections 5-8: buffers that outlived their use, and React state. */
function laterSections(
  s: IHeapSnapshot,
  caps: Caps,
  leads: Lead[],
  section: 'diag' | 'finished' | 'stale' | 'lists',
): string[] {
  switch (section) {
    case 'diag': {
      const skipIds = new Set(leads.flatMap(l => l.ids ?? []));
      return numbered(
        SEC.diag,
        diagnosticBuffersSweepSection(s, {cap: caps.extra, skipIds}),
      );
    }
    case 'finished':
      return numbered(
        SEC.finished,
        finishedStateSweepSection(s, {cap: caps.extra}),
      );
    case 'stale': {
      const found: StaleReactLead[] = [];
      const lines = reactStaleRefsSweepSection(s, {
        cap: caps.extra,
        section: SEC.stale,
        leads: found,
      });
      leads.push(...found);
      return lines;
    }
    case 'lists':
      return numbered(SEC.lists, fiberCensusSweepSection(s));
  }
}

/** `| a | b |` -> cells. */
export const cells = (row: string) =>
  row
    .replace(/^\|\s*|\s*\|$/g, '')
    // Padded (`a | b`) and compact (`a|b`, terse sessions) tables; `\|` is a
    // pipe inside a cell.
    .split(/\s*(?<!\\)\|\s*/)
    .map(c => c.trim());

type Rung = (fn: (s: IHeapSnapshot) => void) => Promise<void>;

async function ladder(
  target: IHeapSnapshot,
  rungs: Rung[],
  names: {baseline: string; target: string},
  caps: Caps,
  leads: Lead[],
): Promise<string[]> {
  const tracker = new ObjectGrowthTracker();
  let anchors: string[] = [];
  const anchorLeads: Lead[] = [];
  await rungs[0](b => {
    tracker.addRung(b);
    const md = renderGrowthAnchors(b, target, names, {
      limit: caps.anchors,
      minBytes: 64 * 1024,
      reached: productionReach(target),
      includeEngine: false,
      includeArtifacts: false,
    });
    const table = md.split('\n').filter(l => /^\|/.test(l));
    if (table.length < 3) {
      // No rows: say why in one line (ids not pairable, or nothing big).
      const why = md.split('\n').find(l => l.startsWith('**')) ?? '';
      anchors = why !== '' ? [`- anchors: ${why}`] : [];
      return;
    }
    anchors = table.slice(2).map(r => {
      const [anchor, holder, path, objs, self, retained, classes] = cells(r);
      const id = /@(\d+)/.exec(anchor)?.[1];
      if (id != null && !anchor.includes('(root)')) {
        anchorLeads.push({
          label: holder,
          bytes: 0,
          ids: [Number(id)],
          section: SEC.growth,
        });
      }
      const at = anchor.includes('(root)')
        ? `(no pre-existing owner) via ${tick(clip(path, 40))}`
        : `${anchor} ${tick(holder)} (${clip(path, 40)})`;
      return `- ${at}: +${objs} new objects, ${self} new self, ${retained} retained; ${clip(classes, 90)}`;
    });
  });
  for (const r of rungs.slice(1)) await r(s => tracker.addRung(s));
  tracker.addRung(target);
  const t = {minEdges: 20, minRetained: 50 * 1024};
  const {rows, total, mismatchShare} = tracker.finish(target, t);
  const n = rungs.length + 1;
  // formatObjectGrowth prints only its warning for no rows: ids that name a
  // different class on another rung mean separate sessions.
  if (formatObjectGrowth([], 0, t, mismatchShare).length > 0) {
    return [
      `## 11. Growth across ${n} snapshots`,
      '',
      `- **Not compared by id:** ${(mismatchShare * 100).toFixed(0)}% of the node ids these snapshots share name a different class, so they are separate sessions (a reload, another tab or build). Compare by class instead → \`memlab_diff_snapshots\` / \`memlab_explain_delta\``,
      '',
    ];
  }
  leads.push(...anchorLeads);
  const growth: string[] = [];
  for (const r of rows.slice(0, caps.growth)) {
    const last = r.retained.length - 1;
    const delta = r.retained[last] - r.retained[0];
    leads.push({
      label: r.holder,
      bytes: delta,
      ids: [r.id],
      section: SEC.growth,
    });
    growth.push(
      `- @${r.id} ${clip(r.name, 30)} ${tick(r.holder)} edges ${r.edges.map(formatNumber).join('→')}, ` +
        `retained ${r.retained.map(formatBytes).join('→')} (+${formatBytes(delta)})` +
        `${r.chain != null ? `; chain ${r.chain}` : ''} → \`memlab_collection_trend\``,
    );
  }
  if (growth.length === 0 && anchors.length === 0) return [];
  return [
    `## 11. Growth across ${n} snapshots (oldest first; ids from the last)`,
    '',
    ...(growth.length > 0
      ? [
          `**Same-id objects that grew at every rung** (${formatNumber(Math.min(rows.length, caps.growth))} of ${formatNumber(total)}) → \`memlab_collection_diff({include_objects:true})\``,
          ...growth,
          '',
        ]
      : []),
    ...(anchors.length > 0
      ? [
          `**Growth anchors ${tick(names.baseline)} → ${tick(names.target)}** (pre-existing owners of new objects) → \`memlab_explain_delta({group_by:"anchor"})\``,
          ...anchors,
          '',
        ]
      : []),
  ];
}

/** Section 12: the residual call that cuts the top leads, ready to paste. */
export function residualCall(leads: Lead[], cap: number): string | null {
  // One lead per section in turn, largest first, ladder growth first and the
  // top-retained rows last, so no one section fills the call.
  const bySection = new Map<number, Lead[]>();
  // React lists (§8) are not cuts: a list parent retains the whole list.
  for (const sec of [
    SEC.growth,
    SEC.dead,
    SEC.buffers,
    SEC.stale,
    SEC.async,
    SEC.finished,
    SEC.diag,
    SEC.strings,
    SEC.top,
  ]) {
    bySection.set(sec, []);
  }
  for (const l of leads) bySection.get(l.section)?.push(l);
  const queues = [...bySection.values()].map(q =>
    q.sort((a, b) => b.bytes - a.bytes),
  );
  const ordered: Lead[] = [];
  for (let i = 0; queues.some(q => i < q.length); i++) {
    for (const q of queues) if (i < q.length) ordered.push(q[i]);
  }
  const seen = new Set<string>();
  const labels = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const l of ordered) {
    const key = l.edge ?? (l.ids ?? []).join(',');
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    const raw = l.label.replace(/["\\]/g, "'");
    let label = raw.length > 40 ? `${raw.slice(0, 12)}…${raw.slice(-27)}` : raw;
    // Entries sharing a label are merged by memlab_residual; keep them apart.
    for (let k = 2; labels.has(label); k++) label = `${clip(raw, 36)} #${k}`;
    labels.add(label);
    out.push(l.edge != null ? {label, edge: l.edge} : {label, node_ids: l.ids});
    if (out.length >= cap) break;
  }
  if (out.length === 0) return null;
  return `memlab_residual({explained: [\n${out.map(o => `  ${JSON.stringify(o)}`).join(',\n')}\n]})`;
}

export function registerSweep(server: McpServer): void {
  server.tool(
    'memlab_sweep',
    'The one call to make after memlab_load_snapshot: every first-pass lead in ONE compact report. Runs the sweep the best manual investigations followed, each section capped and omitted when empty: (1) top ~30 retained objects (strings and code excluded) with holder, marked when held directly by the GC root, a global or a module; (2) collections with ≥500 entries flagged at least 25% dead, plus the largest; (3) string families; (4) flagged framework buffers (per-call keys, cancelled scheduler tasks, cancelled-in-place listener arrays, oversized logs); (5) diagnostic buffers: error histories with repeated errors, the Performance timeline, telemetry queues; (6) finished traces, streams and uploads that still own their buffers; (7) React state holding dead UI: effect cleanups capturing detached DOM, registries keyed to unmounted fibers; (8) React lists: rendered items vs virtualized shells and per-item child counts; (9) the largest class by self size, and heap numbers, grouped by holder `Class.edge`; (10) async flags and Node.js server flags, including vm realms held per cache key and scripts loaded but never evaluated; (11) with 2+ snapshots (`paths`, or several resident): same-id objects that grew at every rung and growth anchors; (12) a ready-to-paste memlab_residual call that cuts the top leads, to look at the long tail. ' +
      'Each lead is one line or row with @id, holder, bytes, why, and the tool to drill with. Leads are not verdicts: a single snapshot shows standing sizes, not rates. About 14 KB by default; `detail:"full"` raises every cap (about 34 KB). Section timings are in the footer.',
    {
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Snapshot paths, OLDEST FIRST. Sections 1-10 run on the LAST one, which becomes the active snapshot (so its @ids can be drilled); with 2 or more, section 11 compares them. Without it, the active snapshot is swept, and section 11 uses the other resident snapshots, in load order.',
        ),
      detail: z
        .enum(['leads', 'full'])
        .optional()
        .default('leads')
        .describe(
          '"leads" (default, about 14 KB) or "full" (larger caps, about 34 KB).',
        ),
    },
    async ({paths, detail}) => {
      try {
        const caps = capsFor(detail);
        const t0 = Date.now();
        const times: string[] = [];
        let rungs: Rung[] = [];
        let baselineName = '';
        // The rungs this call read, oldest first, the swept one last.
        let header: string | undefined;
        if (paths != null && paths.length > 0) {
          const {rungs: resolved} = resolveRungs(paths);
          const last = resolved[resolved.length - 1];
          const handle = await loadSnapshotByPath(last.localPath);
          if (handle == null) {
            return errorResult(`Could not load ${last.localPath}.`);
          }
          rungs = resolved.slice(0, -1).map(r => async fn => {
            await withSnapshotAt(r.localPath, fn);
          });
          baselineName = resolved[0].label;
          header = pathsHeader(resolved.map(r => r.label));
          times.push(`load ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        }
        const s = getSnapshot();
        const meta = getSnapshotMetadata();
        if (rungs.length === 0) {
          const others = listSnapshots().filter(
            m => m.handle !== meta?.handle && !m.light,
          );
          rungs = others.map(m => async fn => {
            const other = getMetadataByHandle(m.handle);
            if (other != null) await withSnapshotAt(other.filePath, fn);
          });
          baselineName = others[0]?.fileName ?? '';
          if (others.length > 0) {
            header = pathsHeader([
              ...others.map(m => m.fileName),
              meta?.fileName ?? '',
            ]);
          }
        }
        const leads: Lead[] = [];
        const timed = async (
          name: string,
          f: () => Promise<string[]> | string[],
        ) => {
          const start = Date.now();
          const lines = await f();
          times.push(`${name} ${((Date.now() - start) / 1000).toFixed(1)}s`);
          return lines;
        };
        const env = meta?.env ?? 'unknown';
        const total = s.nodes.get(0)?.retainedSize ?? 0;
        const lines = [
          `# Sweep: ${meta?.fileName ?? 'snapshot'} (${formatNumber(s.nodes.length)} nodes, ${formatBytes(total)}, ${envLabelOf({env})})`,
          '',
          '_Leads, not verdicts: each line names @id, holder, bytes, why, and the tool to drill with. One snapshot shows standing sizes, not rates. Detached DOM trees themselves: `memlab_detached_dom`._',
          '',
          ...(await timed('top', () => topRetained(s, caps, leads))),
          ...(await timed('collections', () => collections(s, caps, leads))),
          ...(await timed('strings', () => strings(s, caps, leads))),
          ...(await timed('buffers', () => buffers(s, caps, leads))),
          ...(await timed('diag', () => laterSections(s, caps, leads, 'diag'))),
          ...(await timed('finished', () =>
            laterSections(s, caps, leads, 'finished'),
          )),
          ...(await timed('react', () =>
            laterSections(s, caps, leads, 'stale'),
          )),
          ...(await timed('lists', () =>
            laterSections(s, caps, leads, 'lists'),
          )),
          ...(await timed('classes', () => classByHolder(s, caps))),
          ...(await timed('async', () => asyncAndNode(s, env, leads))),
        ];
        if (rungs.length > 0) {
          lines.push(
            ...(await timed('ladder', () =>
              ladder(
                s,
                rungs,
                {baseline: baselineName, target: meta?.fileName ?? 'target'},
                caps,
                leads,
              ),
            )),
          );
        }
        const call = residualCall(leads, caps.cuts);
        recordSweepLeads(s, leads);
        const tail: string[] = [];
        if (call != null) {
          tail.push(
            '## 12. Next step: cut the leads above and look at what is left',
            '',
            '```',
            call,
            '```',
            'Drop the labels that turn out to be expected, add what you explain, and call again.',
            '',
          );
        }
        // The budget cuts the sections, never the residual call.
        let text = lines.join('\n');
        const room = caps.budget - tail.join('\n').length;
        if (text.length > room) {
          text = `${text.slice(0, Math.max(0, room))}\n… (cut at ${formatBytes(caps.budget)}; \`detail:"full"\` raises the caps)\n`;
        }
        text += `\n${tail.join('\n')}`;
        times.push(`total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return toolResult(
          `${text}\n\n**Timings:** ${times.join(' · ')}`,
          header,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
