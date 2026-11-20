/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * Per-function code A/B between two builds (or two captures of one build).
 *
 * A class-level `BytecodeArray` delta mixes a build that emits more bytecode
 * per function with a capture where V8 had compiled (or not yet flushed) more
 * functions. On one React-compiler A/B the class delta was +331 KB, of which
 * same-function growth was +45 KB. Joining SharedFunctionInfos by name and
 * script separates the two.
 */

import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {
  armScanBudgetFor,
  resolveRungs,
  scaledTimeoutMs,
  withSnapshotAt,
} from '../snapshot-borrow.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  pathsHeader,
  toolResult,
} from '../utils.js';

const KINDS = ['bytecode', 'jit', 'feedback', 'uncompiled'] as const;
type CodeKind = (typeof KINDS)[number];
type KindBytes = Record<CodeKind, number>;
const KIND_LABEL: Record<CodeKind, string> = {
  bytecode: 'bytecode (BytecodeArray, constant pool, positions, handlers)',
  jit: 'machine code (Code, instruction stream, reloc/deopt data)',
  feedback: 'feedback metadata',
  uncompiled: 'uncompiled data (UncompiledData*, PreparseData)',
};

export interface FnRecord {
  name: string;
  /** Script URL without its query string. */
  script: string;
  state: 'compiled' | 'uncompiled' | 'other';
  bytes: KindBytes;
  /** BytecodeArray self size alone. */
  array: number;
  id: number;
}

const zero = (): KindBytes => ({
  bytecode: 0,
  jit: 0,
  feedback: 0,
  uncompiled: 0,
});
const total = (b: KindBytes): number =>
  b.bytecode + b.jit + b.feedback + b.uncompiled;

// `(code for f)`, `(BASELINE code)`, `(MAGLEV code)`.
const CODE_OBJ_RE = /^\((code for |[A-Z_]+ code\))/;
const WRAPPER_RE =
  /^system \/ (CodeDataContainer|CodeWrapper|BytecodeWrapper|InterpreterData)$/;
const JIT_EDGES = new Set([
  'instruction_stream',
  'relocation_info',
  'bytecode_offset_table',
  'deoptimization_data',
  'source_position_table',
]);

/** Every script-backed SharedFunctionInfo with its code bytes, in one pass. */
export function collectFunctions(snapshot: IHeapSnapshot): FnRecord[] {
  const out: FnRecord[] = [];
  // A shared child (an empty constant pool) is counted once per snapshot.
  const seen = new Set<number>();
  const take = (n: IHeapNode): number => {
    if (seen.has(n.nodeIndex)) return 0;
    seen.add(n.nodeIndex);
    return n.self_size;
  };
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (node.type !== 'code') return;
    let fd: IHeapNode | null = null;
    let script: IHeapNode | null = null;
    let meta: IHeapNode | null = null;
    for (const e of node.references) {
      const k = e.name_or_index;
      if (k === 'function_data') fd = e.toNode;
      else if (k === 'script' || k === 'script_or_debug_info')
        script = e.toNode;
      else if (k === 'raw_outer_scope_info_or_feedback_metadata')
        meta = e.toNode;
    }
    if (fd == null || script == null) return;
    const bytes = zero();
    let state: FnRecord['state'] = 'other';
    let bca: IHeapNode | null = null;
    let cur: IHeapNode | null = fd;
    // function_data → [container →] Code → interpreter_data → BytecodeArray
    for (let hop = 0; cur != null && hop < 3; hop++) {
      const name: string = cur.name;
      if (name === 'system / BytecodeArray') {
        bca = cur;
        break;
      }
      if (name.startsWith('system / UncompiledData')) {
        state = 'uncompiled';
        bytes.uncompiled += take(cur);
        for (const e of cur.references) {
          if (e.toNode.name === 'system / PreparseData')
            bytes.uncompiled += take(e.toNode);
        }
        break;
      }
      if (CODE_OBJ_RE.test(name)) {
        state = 'compiled';
        bytes.jit += take(cur);
        for (const e of cur.references) {
          const k = String(e.name_or_index);
          const t = e.toNode;
          if (k === 'interpreter_data') {
            bca =
              t.name === 'system / BytecodeArray'
                ? t
                : (t.references.find(x => x.name_or_index === 'bytecode_array')
                    ?.toNode ?? null);
          } else if (JIT_EDGES.has(k)) {
            bytes.jit += take(t);
            if (k !== 'instruction_stream') continue;
            for (const x of t.references) {
              if (JIT_EDGES.has(String(x.name_or_index)))
                bytes.jit += take(x.toNode);
            }
          }
        }
        break;
      }
      const wrapper = name === '' || WRAPPER_RE.test(name);
      if (cur.type !== 'code' || !wrapper) break;
      bytes.jit += take(cur);
      cur =
        cur.references.find(
          e => e.name_or_index !== 'map' && e.toNode.type === 'code',
        )?.toNode ?? null;
    }
    let array = 0;
    if (bca != null) {
      state = 'compiled';
      array = bca.self_size;
      bytes.bytecode += take(bca);
      for (const e of bca.references) {
        if (e.name_or_index !== 'map' && e.toNode.type === 'code')
          bytes.bytecode += take(e.toNode);
      }
    }
    if (meta?.name === 'system / FeedbackMetadata')
      bytes.feedback += take(meta);
    out.push({
      name: node.name,
      script: script.name.replace(/[?#].*$/, ''),
      state,
      bytes,
      array,
      id: node.id,
    });
  });
  return out;
}

/** A React component by convention: PascalCase with a lower-case letter. */
export function isComponentName(name: string): boolean {
  return /^[A-Z][\w$]*[a-z][\w$]*$/.test(name);
}

function quantile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** Unique name + script; a duplicated pair cannot be matched (null). */
function keyed(recs: FnRecord[]): Map<string, FnRecord | null> {
  const m = new Map<string, FnRecord | null>();
  for (const r of recs) {
    if (r.name === '' || r.name === '(shared function info)') continue;
    const k = `${r.name}\u0000${r.script}`;
    m.set(k, m.has(k) ? null : r);
  }
  return m;
}

function group() {
  return {
    count: 0,
    changed: 0,
    a: 0,
    b: 0,
    arrayDelta: 0,
    ratios: [] as number[],
    median: null as number | null,
    p90: null as number | null,
  };
}

export type CodeDiff = ReturnType<typeof diffCode>;

export function diffCode(a: FnRecord[], b: FnRecord[], top = 10) {
  const kb = keyed(b);
  const matchedA = new Set<FnRecord>();
  const matchedB = new Set<FnRecord>();
  const same = zero();
  const flips = {aOnly: 0, aOnlyBytes: 0, bOnly: 0, bOnlyBytes: 0};
  const groups = {components: group(), others: group()};
  const pairs: Array<{a: FnRecord; b: FnRecord}> = [];
  for (const [k, ra] of keyed(a)) {
    const rb = kb.get(k);
    if (ra == null || rb == null) continue;
    matchedA.add(ra);
    matchedB.add(rb);
    const d = total(rb.bytes) - total(ra.bytes);
    const states = `${ra.state}>${rb.state}`;
    if (states === 'compiled>uncompiled' || states === 'uncompiled>compiled') {
      const side = ra.state === 'compiled' ? 'aOnly' : 'bOnly';
      flips[side]++;
      flips[`${side}Bytes` as const] += d;
      continue;
    }
    for (const kind of KINDS) same[kind] += rb.bytes[kind] - ra.bytes[kind];
    if (ra.state !== 'compiled' || rb.state !== 'compiled') continue;
    const s = groups[isComponentName(ra.name) ? 'components' : 'others'];
    s.count++;
    s.a += ra.bytes.bytecode;
    s.b += rb.bytes.bytecode;
    s.arrayDelta += rb.array - ra.array;
    if (rb.bytes.bytecode === ra.bytes.bytecode) continue;
    s.changed++;
    if (ra.bytes.bytecode > 0)
      s.ratios.push(rb.bytes.bytecode / ra.bytes.bytecode);
    pairs.push({a: ra, b: rb});
  }
  for (const s of Object.values(groups)) {
    s.ratios.sort((x, y) => x - y);
    s.median = quantile(s.ratios, 0.5);
    s.p90 = quantile(s.ratios, 0.9);
  }
  const growth = (p: {a: FnRecord; b: FnRecord}) =>
    Math.abs(p.b.bytes.bytecode - p.a.bytes.bytecode);
  pairs.sort((x, y) => growth(y) - growth(x));
  const ua = a.filter(r => !matchedA.has(r));
  const ub = b.filter(r => !matchedB.has(r));
  const scriptsA = new Set(a.map(r => r.script));
  const scriptsB = new Set(b.map(r => r.script));
  const sum = (recs: FnRecord[]) =>
    recs.reduce((t, r) => t + total(r.bytes), 0);
  const kinds = (recs: FnRecord[]) => {
    const t = zero();
    for (const r of recs) for (const k of KINDS) t[k] += r.bytes[k];
    return t;
  };
  const compiled = (recs: FnRecord[]) =>
    recs.filter(r => r.state === 'compiled').length;
  return {
    totals: [kinds(a), kinds(b)] as const,
    sfis: [a.length, b.length, compiled(a), compiled(b)] as const,
    matched: matchedA.size,
    same,
    groups,
    top: pairs.slice(0, top),
    flips,
    unmatched: {
      delta: sum(ub) - sum(ua),
      count: [ua.length, ub.length] as const,
      compiled: [compiled(ua), compiled(ub)] as const,
      /** Bytes of functions whose script only one snapshot loaded. */
      oneSideScripts: [
        sum(ua.filter(r => !scriptsB.has(r.script))),
        sum(ub.filter(r => !scriptsA.has(r.script))),
      ] as const,
    },
  };
}

const signed = (n: number) =>
  n < 0 ? `-${formatBytes(-n)}` : `+${formatBytes(n)}`;
const ratio = (v: number | null) => (v == null ? '—' : `${v.toFixed(2)}×`);
const n = formatNumber;
const clip = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

export function renderCodeDiff(d: CodeDiff, labels: [string, string]): string {
  const [ta, tb] = d.totals;
  const net = total(tb) - total(ta);
  const flipNet = d.flips.aOnlyBytes + d.flips.bOnlyBytes;
  const u = d.unmatched;
  const sameCode = total(d.same) - d.same.jit;
  const {components: gc, others: go} = d.groups;
  const lines = [
    `## Code diff — A \`${labels[0]}\` → B \`${labels[1]}\``,
    '',
    `**Net code ${signed(net)} = same-function bytecode ${signed(sameCode)} + same-function machine code ${signed(d.same.jit)} + flips ${signed(flipNet)} + unmatched ${signed(u.delta)}.** ` +
      'Only same-function bytecode is a build effect; the rest is tier-up, lazy compilation and flushing.',
    '',
    `- same-function bytecode: ${signed(sameCode)} (bytecode ${signed(d.same.bytecode)}, feedback metadata ${signed(d.same.feedback)}); ${n(gc.changed + go.changed)} of ${n(gc.count + go.count)} functions compiled in both changed size`,
    `- same-function machine code: ${signed(d.same.jit)} (baseline/optimized code of functions compiled in both; tier-up state, not code size)`,
    `- compile-state flips (bytecode in one snapshot, uncompiled in the other): ${signed(flipNet)}; ${n(d.flips.aOnly)} compiled in A only (${signed(d.flips.aOnlyBytes)}), ${n(d.flips.bOnly)} in B only (${signed(d.flips.bOnlyBytes)})`,
    `- unmatched (anonymous, duplicated or one-side names): ${signed(u.delta)}; compiled ${n(u.compiled[0])} → ${n(u.compiled[1])} of ${n(u.count[0])} → ${n(u.count[1])}; in scripts only A / only B loaded: ${formatBytes(u.oneSideScripts[0])} / ${formatBytes(u.oneSideScripts[1])}`,
    '',
    markdownTable(
      ['Kind', 'A', 'B', 'Δ'],
      [
        ...KINDS.map(k => [
          KIND_LABEL[k],
          formatBytes(ta[k]),
          formatBytes(tb[k]),
          signed(tb[k] - ta[k]),
        ]),
        [
          '**total**',
          formatBytes(total(ta)),
          formatBytes(total(tb)),
          signed(net),
        ],
      ],
      new Set([1, 2, 3]),
    ),
    '',
    `- SharedFunctionInfos with a script: A ${n(d.sfis[0])} (${n(d.sfis[2])} compiled), B ${n(d.sfis[1])} (${n(d.sfis[3])} compiled); ${n(d.matched)} matched by unique name + script URL`,
    '',
    '### Same function, compiled in both (ratios over changed functions)',
    '',
    markdownTable(
      [
        'Group',
        'Functions',
        'Changed',
        'Bytecode A',
        'Bytecode B',
        'Δ (BytecodeArray only)',
        'Median B/A',
        'p90 B/A',
      ],
      [
        ['components (PascalCase)', gc],
        ['other functions', go],
      ].map(([label, s]) => {
        const g = s as typeof gc;
        return [
          label as string,
          n(g.count),
          n(g.changed),
          formatBytes(g.a),
          formatBytes(g.b),
          `${signed(g.b - g.a)} (${signed(g.arrayDelta)})`,
          ratio(g.median),
          ratio(g.p90),
        ];
      }),
      new Set([1, 2, 3, 4, 5, 6, 7]),
    ),
  ];
  if (d.top.length > 0) {
    lines.push(
      '',
      markdownTable(
        ['Function', 'Script', 'A', 'B', 'Δ', 'B/A', 'SFI A / B'],
        d.top.map(({a, b}) => [
          clip(a.name, 40),
          clip(a.script.replace(/^.*\//, '') || '(no url)', 32),
          formatBytes(a.bytes.bytecode),
          formatBytes(b.bytes.bytecode),
          signed(b.bytes.bytecode - a.bytes.bytecode),
          ratio(
            a.bytes.bytecode > 0 ? b.bytes.bytecode / a.bytes.bytecode : null,
          ),
          `@${a.id} / @${b.id}`,
        ]),
        new Set([2, 3, 4, 5]),
      ),
    );
  }
  lines.push(
    '',
    '_Flips, and a changed compiled count among unmatched functions, follow lazy compilation and bytecode flushing, which differ between runs of the SAME build. ' +
      'Counted per function: bytecode, machine code, FeedbackMetadata and UncompiledData; per-closure FeedbackVectors, ScopeInfos and script line ends are not. ' +
      'Read one function with `memlab_get_node` on its SFI id._',
  );
  return lines.join('\n');
}

export function registerCodeDiff(server: McpServer): void {
  server.tool(
    'memlab_code_diff',
    'Per-function code-size A/B between two snapshots (two builds, or two captures of one build). Joins SharedFunctionInfos by unique name + script URL and splits the code-byte delta (bytecode, machine code, feedback metadata, uncompiled data) into: same-function size change (React components, by PascalCase name, vs other functions; median/p90 B/A ratio; top functions by delta), compile-state flips (bytecode in one snapshot, flushed or never compiled in the other), and unmatched functions. ' +
      'Use it before reading a `BytecodeArray` class delta as a build effect: lazy compilation and bytecode flushing differ between captures and can dominate it. ' +
      'Takes `paths: [A, B]`: files or resident handles (from memlab_snapshots).',
    {
      paths: z
        .array(z.string())
        .length(2)
        .describe('[A, B]: .heapsnapshot paths or resident handles, A first.'),
      top: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe('Rows in the top-delta function table (default 10).'),
      max_file_size_mb: z
        .number()
        .optional()
        .describe('Per-file size ceiling, matching memlab_load_snapshot.'),
    },
    async ({paths, top, max_file_size_mb}) => {
      try {
        const {rungs, largestMB} = resolveRungs(paths, max_file_size_mb);
        const recs: FnRecord[][] = [];
        for (const r of rungs) {
          armScanBudgetFor(scaledTimeoutMs(largestMB));
          recs.push(await withSnapshotAt(r.localPath, collectFunctions));
        }
        const header = pathsHeader(rungs.map(r => r.label));
        if (recs[0].length === 0 && recs[1].length === 0) {
          return toolResult('No script-backed functions in either.', header);
        }
        const diff = diffCode(recs[0], recs[1], top);
        return toolResult(
          renderCodeDiff(diff, [rungs[0].label, rungs[1].label]),
          header,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
