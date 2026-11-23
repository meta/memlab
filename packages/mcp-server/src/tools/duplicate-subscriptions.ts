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
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {
  CALLBACK_PROPS,
  CONTEXT_PROPS,
  DEFAULT_MIN_REGISTRY_EVENTS,
  registryEvents,
} from '../emitter-shapes.js';
import {getSnapshotMetadata, listSnapshots} from '../heap-state.js';
import {recordLead} from '../lead-registry.js';
import {resolveRungs, withSnapshotAt} from '../snapshot-borrow.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
  truncateNodeName,
  enumerateSetElements,
} from '../utils.js';

/** One listener registration found in a listener store. */
export interface Registration {
  /** The emitter, collection owner or DOM event target. */
  storeId: number;
  store: string;
  /** Event name, or '' when the store does not record one (DOM, Sets). */
  event: string;
  /** The listener's context / subscriber object id, or 0. */
  subscriber: number;
  /** Identity of the callback's code (its SharedFunctionInfo). */
  code: string;
  /** Same code across snapshots: name and source position. */
  codeStable: string;
  codeLabel: string;
  closureId: number;
  /** The callback closure's retained size. */
  bytes: number;
  kind: 'emitter' | 'set' | 'dom';
}

const NOT_A_SUBSCRIBER =
  /^(?:(?:undefined|null|true|false|the_hole)(?![\w$])|system \/ )/;

/** A context that is a real object, else 0 (an `undefined` context is none). */
function subscriberId(snapshot: IHeapSnapshot, id: number): number {
  if (id <= 3) return 0;
  const n = snapshot.getNodeById(id);
  if (n == null || n.type === 'hidden' || NOT_A_SUBSCRIBER.test(n.name)) {
    return 0;
  }
  return id;
}

const DOM_LISTENER_NAMES = new Set([
  'V8EventListener',
  'JSEventListener',
  'JSBasedEventListener',
]);
const DOM_INTERNAL =
  /^(?:blink::|cppgc::)?\w*(?:EventListener|EventTargetData|InternalNode|HeapVector|HeapHashMap|HeapHashSet|HashTable|Member|TraceWrapper)\w*|^\(|^system \/ /;

function boundTarget(closure: IHeapNode): {
  fn: IHeapNode;
  subscriber: number;
} {
  let fn = closure;
  let subscriber = 0;
  const seen = new Set<number>();
  while (!seen.has(fn.id)) {
    seen.add(fn.id);
    let target: IHeapNode | null = null;
    let receiver = 0;
    for (const e of fn.references) {
      if (e.type !== 'internal') {
        continue;
      }
      const name = String(e.name_or_index);
      if (name === 'bound_function') {
        target = e.toNode;
      } else if (name === 'bound_this') {
        receiver = e.toNode.id;
      }
    }
    if (target == null) {
      break;
    }
    subscriber = receiver;
    fn = target;
  }
  return {fn, subscriber};
}

function codeOf(closure: IHeapNode): {
  code: string;
  stable: string;
  label: string;
  subscriber: number;
} {
  const {fn, subscriber} = boundTarget(closure);
  let sfi = 0;
  for (const e of fn.references) {
    if (String(e.name_or_index) === 'shared') {
      sfi = e.toNode.id;
      break;
    }
  }
  const name = fn.name || '(anonymous)';
  const loc = fn.location;
  const at = loc != null ? `:${loc.line + 1}:${loc.column + 1}` : '';
  return {
    code: sfi > 0 ? `sfi:${sfi}` : `name:${name}${at}`,
    stable: `${name}${at}`,
    label: `${truncateNodeName(name, fn.type, fn.self_size, 40)}${at}`,
    subscriber,
  };
}

function ownerLabel(container: IHeapNode): {id: number; label: string} {
  for (const e of container.referrers) {
    if (e.type !== 'property' && e.type !== 'context') continue;
    const from = e.fromNode;
    const cls = e.type === 'context' ? 'closure var' : from.name || from.type;
    return {
      id: from.id,
      label: `${truncateNodeName(cls, from.type, from.self_size, 40)}.${String(e.name_or_index)}`,
    };
  }
  return {id: container.id, label: `${container.name} @${container.id}`};
}

function domTarget(listener: IHeapNode): IHeapNode | null {
  let frontier = [listener];
  const seen = new Set<number>([listener.id]);
  for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
    const next: IHeapNode[] = [];
    for (const n of frontier) {
      for (const r of n.referrers) {
        const from = r.fromNode;
        if (seen.has(from.id)) continue;
        seen.add(from.id);
        if (!DOM_INTERNAL.test(from.name)) return from;
        next.push(from);
      }
    }
    frontier = next;
  }
  return null;
}

function closureOfListener(node: IHeapNode): IHeapNode | null {
  for (const e of node.references) {
    if (e.toNode.type === 'closure') return e.toNode;
  }
  return null;
}

/** Every registration in emitter registries, listener Sets and DOM targets. */
export function collectRegistrations(snapshot: IHeapSnapshot): Registration[] {
  const out: Registration[] = [];
  const add = (
    kind: Registration['kind'],
    storeId: number,
    store: string,
    event: string,
    subscriber: number,
    closure: IHeapNode,
  ): void => {
    const c = codeOf(closure);
    out.push({
      kind,
      storeId,
      store,
      event,
      subscriber:
        subscriberId(snapshot, subscriber) ||
        subscriberId(snapshot, c.subscriber),
      code: c.code,
      codeStable: c.stable,
      codeLabel: c.label,
      closureId: closure.id,
      bytes: closure.retainedSize,
    });
  };
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (node.id <= 3) return;
    if (DOM_LISTENER_NAMES.has(node.name)) {
      const fn = closureOfListener(node);
      const target = domTarget(node);
      if (fn == null || target == null) return;
      add(
        'dom',
        target.id,
        `${truncateNodeName(target.name, target.type, target.self_size, 40)} @${target.id}`,
        '',
        0,
        fn,
      );
      return;
    }
    if (node.name === 'Set' && node.type === 'object') {
      const elems = enumerateSetElements(node);
      if (elems.length === 0) return;
      const regs: Array<[number, IHeapNode]> = [];
      for (const el of elems) {
        if (el.type === 'closure') {
          regs.push([0, el]);
          continue;
        }
        let cb: IHeapNode | null = null;
        let ctx = 0;
        for (const e of el.references) {
          const p = String(e.name_or_index);
          if (CALLBACK_PROPS.has(p) && e.toNode.type === 'closure') {
            cb = e.toNode;
          } else if (CONTEXT_PROPS.has(p)) ctx = e.toNode.id;
        }
        if (cb == null) continue;
        regs.push([ctx, cb]);
      }
      const owner = ownerLabel(node);
      for (const [ctx, cb] of regs) {
        add('set', node.id, owner.label, '', ctx, cb);
      }
      return;
    }
    const events = registryEvents(node, DEFAULT_MIN_REGISTRY_EVENTS);
    if (events == null) return;
    const owner = ownerLabel(node);
    for (const {name: event, listeners} of events) {
      for (const l of listeners) {
        const fn = snapshot.getNodeById(l.callbackId);
        if (fn == null || fn.type !== 'closure') continue;
        add('emitter', node.id, owner.label, event, l.contextId, fn);
      }
    }
  });
  return out;
}

export interface DuplicateGroup {
  store: string;
  event: string;
  subscriber: number;
  codeLabel: string;
  registrations: number;
  closures: number;
  exampleClosure: number;
  bytes: number;
}

/**
 * Registrations of the same callback code for the same subscriber on the same
 * store and event, registered more than once. DOM listeners are excluded because
 * their event types are unavailable in the snapshot.
 */
export function duplicateGroups(regs: readonly Registration[]): {
  duplicates: DuplicateGroup[];
  perCode: Array<{
    store: string;
    event: string;
    codeLabel: string;
    registrations: number;
    subscribers: number;
    subs: ReadonlySet<number>;
  }>;
} {
  const byKey = new Map<string, DuplicateGroup & {ids: Set<number>}>();
  const byCode = new Map<
    string,
    {
      store: string;
      event: string;
      codeLabel: string;
      registrations: number;
      subs: Set<number>;
    }
  >();
  for (const r of regs) {
    const ck = `${r.storeId}\u0000${r.event}\u0000${r.code}`;
    let c = byCode.get(ck);
    if (c == null) {
      c = {
        store: r.store,
        event: r.event,
        codeLabel: r.codeLabel,
        registrations: 0,
        subs: new Set(),
      };
      byCode.set(ck, c);
    }
    c.registrations++;
    if (r.subscriber > 0) {
      c.subs.add(r.subscriber);
    }
    if (r.kind === 'dom') {
      continue;
    }
    const k = `${r.storeId}\u0000${r.event}\u0000${r.subscriber}\u0000${r.code}`;
    let g = byKey.get(k);
    if (g == null) {
      g = {
        store: r.store,
        event: r.event,
        subscriber: r.subscriber,
        codeLabel: r.codeLabel,
        registrations: 0,
        closures: 0,
        exampleClosure: r.closureId,
        bytes: 0,
        ids: new Set(),
      };
      byKey.set(k, g);
    }
    g.registrations++;
    g.bytes += r.bytes;
    g.ids.add(r.closureId);
  }
  const duplicates = [...byKey.values()]
    .map(({ids, ...g}) => ({...g, closures: ids.size}))
    .filter(
      g =>
        g.registrations > 1 &&
        (g.subscriber > 0 || g.closures < g.registrations),
    )
    .sort((a, b) => b.registrations - a.registrations);
  const perCode = [...byCode.values()]
    .map(c => ({...c, subscribers: c.subs.size}))
    .sort((a, b) => b.registrations - a.registrations);
  return {duplicates, perCode};
}

function stableCounts(regs: readonly Registration[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of regs) {
    const store = r.store.replace(/ @\d+$/, '');
    const k = `${r.kind}\u0000${store}\u0000${r.event}\u0000${r.codeStable}`;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

export function registerDuplicateSubscriptions(server: McpServer): void {
  server.tool(
    'memlab_duplicate_subscriptions',
    "Find listeners registered more than once: the same callback code subscribed again and again for the same subscriber, on the same emitter event or listener Set. Each registration is keyed by (store, event, subscriber, callback code), where the code is the function's SharedFunctionInfo, so a fresh closure of the same function counts as the same callback — the usual re-subscribe-on-every-render bug, which a same-instance check misses. " +
      'Scans shape-detected emitter registries (event name → listener arrays, minified or not), Sets of callbacks or subscription objects, and DOM EventTarget listeners. DOM listeners contribute to counts and growth only: event types are not in the snapshot. With 2+ snapshots (`paths`, or several resident) it also reports which (store, event, callback) groups grew across them.',
    {
      limit: z
        .number()
        .optional()
        .default(15)
        .describe('Rows per table (default 15).'),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Snapshot paths or handles, OLDEST FIRST, for the growth table. Default: the resident snapshots in load order, the active one last.',
        ),
    },
    async ({limit, paths}) => {
      try {
        let rungPaths: string[];
        let labels: string[];
        if (paths != null && paths.length > 0) {
          const {rungs} = resolveRungs(paths);
          rungPaths = rungs.map(r => r.localPath);
          labels = rungs.map(r => r.label);
        } else {
          const active = getSnapshotMetadata();
          if (active == null) {
            return errorResult(
              new Error('No snapshot loaded. Use memlab_load_snapshot first.'),
            );
          }
          const others = listSnapshots().filter(
            m => m.handle !== active.handle && !m.light,
          );
          rungPaths = [...others.map(m => m.filePath), active.filePath];
          labels = [...others.map(m => m.handle), active.handle];
        }
        const newest = rungPaths[rungPaths.length - 1];
        const {regs, duplicates, perCode} = await withSnapshotAt(newest, s => {
          const all = collectRegistrations(s);
          const groups = duplicateGroups(all);
          for (const g of groups.duplicates.slice(0, limit)) {
            recordLead(s, {
              label: `${g.store} ${g.event === '' ? '' : `'${g.event}' `}${g.codeLabel}`,
              ids: [g.exampleClosure],
              bytes: g.bytes,
              kind: 'duplicate',
              why: `same callback registered ${formatNumber(g.registrations)}× for one subscriber`,
              source: 'duplicate_subscriptions',
              check: 'memlab_duplicate_subscriptions({})',
            });
          }
          return {regs: all, ...groups};
        });
        const stores = new Set(regs.map(r => r.storeId)).size;
        const byKind = {emitter: 0, set: 0, dom: 0};
        for (const r of regs) byKind[r.kind]++;
        const extra = duplicates.reduce((n, g) => n + g.registrations - 1, 0);
        const lines = [
          `## Duplicate subscriptions (${labels[labels.length - 1]})`,
          '',
          `${formatNumber(regs.length)} registrations in ${formatNumber(stores)} listener stores: ${formatNumber(byKind.emitter)} in emitter event lists, ${formatNumber(byKind.set)} in listener Sets, ${formatNumber(byKind.dom)} on DOM event targets.`,
          '',
          '_DOM listeners contribute to counts and growth only: event types are unavailable, so a callback shared across event types is not classified as a duplicate._',
          '',
        ];
        if (duplicates.length === 0) {
          lines.push(
            'No duplicate subscriptions found in emitter event lists or listener Sets.',
          );
        } else {
          lines.push(
            `**${formatNumber(duplicates.length)} group(s) register the same callback more than once: ${formatNumber(extra)} extra registrations.** Each row is one subscriber with one callback's code registered N times on one store and event, or one closure registered N times. A fresh closure each time (Distinct closures = Registrations) means the code subscribes again on every run instead of once; the same closure repeated means \`add\` without a membership check.`,
            '',
            markdownTable(
              [
                'Store',
                'Event',
                'Callback',
                'Subscriber',
                'Registrations',
                'Distinct closures',
                'Example',
              ],
              duplicates
                .slice(0, limit)
                .map(g => [
                  `\`${g.store}\``,
                  g.event === '' ? '—' : `\`${g.event}\``,
                  `\`${g.codeLabel}\``,
                  g.subscriber > 0 ? `@${g.subscriber}` : '—',
                  formatNumber(g.registrations),
                  formatNumber(g.closures),
                  `@${g.exampleClosure}`,
                ]),
              new Set([4, 5]),
            ),
          );
        }
        const folded = new Map<
          string,
          {
            store: string;
            event: string;
            codeLabel: string;
            registrations: number;
            subs: Set<number>;
            stores: number;
          }
        >();
        for (const c of perCode) {
          const k = `${c.store}\u0000${c.event}\u0000${c.codeLabel}`;
          const f = folded.get(k);
          if (f == null) {
            folded.set(k, {
              store: c.store,
              event: c.event,
              codeLabel: c.codeLabel,
              registrations: c.registrations,
              subs: new Set(c.subs),
              stores: 1,
            });
          } else {
            f.registrations += c.registrations;
            for (const sub of c.subs) f.subs.add(sub);
            f.stores++;
          }
        }
        const wide = [...folded.values()]
          .filter(c => c.registrations >= 20)
          .sort((a, b) => b.registrations - a.registrations)
          .slice(0, limit);
        if (wide.length > 0) {
          lines.push(
            '',
            '### The largest (store, event, callback) groups',
            '',
            markdownTable(
              ['Store', 'Event', 'Callback', 'Registrations', 'Subscribers'],
              wide.map(c => [
                `\`${c.store}\`${c.stores > 1 ? ` ×${formatNumber(c.stores)} stores` : ''}`,
                c.event === '' ? '—' : `\`${c.event}\``,
                `\`${c.codeLabel}\``,
                formatNumber(c.registrations),
                formatNumber(c.subs.size),
              ]),
              new Set([3, 4]),
            ),
            '',
            '_Many registrations from distinct subscribers is one per subscriber, which is normal while the subscribers are alive. It leaks when they are not: check one with `memlab_retainer_trace`, or compare rungs below._',
          );
        }
        if (rungPaths.length > 1) {
          const counts: Array<Map<string, number>> = [];
          for (const p of rungPaths) {
            counts.push(
              p === newest
                ? stableCounts(regs)
                : await withSnapshotAt(p, s =>
                    stableCounts(collectRegistrations(s)),
                  ),
            );
          }
          const first = counts[0];
          const last = counts[counts.length - 1];
          const growth = [...last.entries()]
            .map(([k, n]) => ({k, n, d: n - (first.get(k) ?? 0)}))
            .filter(x => x.d > 0)
            .sort((a, b) => b.d - a.d);
          const emitterGrowth = growth
            .filter(x => !x.k.startsWith('dom\u0000'))
            .slice(0, limit);
          const domGrowth = growth
            .filter(x => x.k.startsWith('dom\u0000'))
            .slice(0, limit);
          lines.push('', `### Growth across ${rungPaths.length} snapshots`, '');
          if (growth.length === 0) {
            lines.push('No (store, event, callback) group grew.');
          }
          for (const [title, grew] of [
            ['Emitters and listener Sets', emitterGrowth],
            [
              'DOM event targets (event types are not in the snapshot)',
              domGrowth,
            ],
          ] as const) {
            if (grew.length === 0) continue;
            lines.push(
              `**${title}**`,
              '',
              markdownTable(
                ['Store', 'Event', 'Callback', ...labels, 'Δ'],
                grew.map(({k, d}) => {
                  const [, store, event, code] = k.split('\u0000');
                  return [
                    `\`${store}\``,
                    event === '' ? '—' : `\`${event}\``,
                    `\`${code}\``,
                    ...counts.map(c => formatNumber(c.get(k) ?? 0)),
                    `+${formatNumber(d)}`,
                  ];
                }),
                new Set(
                  labels.map((_, i) => i + 3).concat([labels.length + 3]),
                ),
              ),
              '',
            );
          }
          if (growth.length > 0) {
            lines.push(
              "_Groups are matched across snapshots by store label, event and the callback's name and source position, since ids differ between snapshots._",
            );
          }
        }
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
