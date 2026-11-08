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
 * True/false questions on what a leak fix most often gets wrong.
 *
 * Each one is a belief that reads plausibly off a retainer trace and has sent a
 * fix in the wrong direction: a cleanup that never runs, a field nulled on a
 * copy React keeps, a growth curve that is a cache filling up. Answering them
 * before writing the fix is cheaper than an A/B round that comes back flat.
 */

export interface FixQuestion {
  id: string;
  topic: string;
  statement: string;
  answer: boolean;
  why: string;
  /** What to measure when unsure. */
  check: string;
}

export const FIX_QUESTIONS: FixQuestion[] = [
  {
    id: 'weakmap-hop',
    topic: 'retention',
    statement:
      'A retainer path whose last hop is a WeakMap key -> value edge proves the WeakMap is what keeps the value alive.',
    answer: false,
    why: 'A WeakMap entry holds its value only while its key is alive. The value is retained by whatever holds the KEY; the WeakMap hop is a consequence, not the cause.',
    check: '`memlab_weakmap_entries` and `memlab_retainer_trace` on the key.',
  },
  {
    id: 'promise-settled',
    topic: 'retention',
    statement:
      'Once a Promise settles, the value it resolved with can be collected.',
    answer: false,
    why: 'A settled Promise keeps its result for as long as the Promise itself is reachable, for example from a cache of in-flight requests that is never pruned.',
    check: '`memlab_pending_promises`, then trace what holds the Promise.',
  },
  {
    id: 'closure-shared-context',
    topic: 'closures',
    statement:
      'In V8, a closure retains only the outer variables it itself uses.',
    answer: false,
    why: 'Closures created in the same scope share one context object, so a variable used by any of them is kept alive by all of them for as long as any one survives.',
    check:
      '`memlab_closure_inspection` / `memlab_scope_chains` on the surviving closure.',
  },
  {
    id: 'react-null-state',
    topic: 'react',
    statement:
      "Setting a component's state or ref to null on unmount is enough to release what it referenced.",
    answer: false,
    why: 'React keeps a second (alternate) fiber per component whose memoized state and props can still point at the old value until that fiber is reused or dropped. Release the source: unsubscribe, remove the listener, clear the external store entry.',
    check:
      '`memlab_react_owners` and the retainer path from the detached fiber.',
  },
  {
    id: 'react-compiler-closures',
    topic: 'react',
    statement:
      'Automatic memoization (for example React Compiler) prevents closures from retaining earlier renders.',
    answer: false,
    why: "A memo cache stores closures, and each closure still captures its render's scope; a cached closure can keep that render's props and state alive.",
    check: '`memlab_scope_chains` on the cached function.',
  },
  {
    id: 'effect-cleanup',
    topic: 'react',
    statement: 'A useEffect cleanup function runs when the component unmounts.',
    answer: true,
    why: 'It does, and before the effect re-runs. A leak that survives unmount is usually registered outside an effect, or cleaned up with a different function reference.',
    check: 'Find the registration site and its matching cleanup.',
  },
  {
    id: 'listener-reference',
    topic: 'listeners',
    statement:
      'removeEventListener removes a listener even when passed a new function with the same body.',
    answer: false,
    why: 'Removal matches the exact function reference (and the capture flag). An inline arrow or a fresh .bind() result never matches, so the listener stays.',
    check:
      '`memlab_event_listener_leaks` / `memlab_event_registry` count per cycle.',
  },
  {
    id: 'abort-signal',
    topic: 'listeners',
    statement:
      'A listener added with an AbortSignal is removed when that signal aborts.',
    answer: true,
    why: 'addEventListener with `{signal}` removes the listener on abort, which avoids keeping a matching function reference around.',
    check: 'Confirm abort() is actually reached on teardown.',
  },
  {
    id: 'detached-always-leak',
    topic: 'dom',
    statement: 'A detached DOM node in a snapshot is always a leak.',
    answer: false,
    why: 'It can be awaiting collection, or deliberately cached. It is a leak when it survives at rest and grows with interaction, and the fix is the JS retainer, not the node.',
    check: '`memlab_settle_check` and `memlab_detached_dom` across rungs.',
  },
  {
    id: 'growth-is-leak',
    topic: 'caches',
    statement: 'A population that grows on every rung of a ladder is a leak.',
    answer: false,
    why: 'A bounded cache grows until it is full and then holds. Look for a plateau and a cap before calling it unbounded.',
    check: '`memlab_rate_model` / `memlab_cache_analysis`; a longer ladder.',
  },
  {
    id: 'snapshot-at-rest',
    topic: 'snapshots',
    statement:
      'A snapshot taken right after the last interaction shows what is retained at rest.',
    answer: false,
    why: 'Timers, pending promises, queued renders and in-flight requests are still alive. Retention is what is left after the page has been idle.',
    check: '`memlab_settle_check` on a settle rung.',
  },
  {
    id: 'dev-only-chain',
    topic: 'dev_build',
    statement:
      'A retainer chain seen in a development build is evidence of the same leak in production.',
    answer: false,
    why: 'Development builds add wrappers, registries (Fast Refresh, devtools hooks) and extra scopes that production does not have. Confirm on a production-like build before fixing.',
    check:
      '`memlab_dev_artifacts` / `memlab_dev_subtracted_delta`, then a production-like round.',
  },
  {
    id: 'partial-fix',
    topic: 'fix',
    statement:
      'A fix that halves the per-cycle growth rate has fixed the leak.',
    answer: false,
    why: 'A leak fix should take the rate to about zero; half is a partial fix, or a second retainer. State the residual rate.',
    check: '`memlab_verify_fix` with the expected reduction.',
  },
  {
    id: 'gate-on-in-capture',
    topic: 'fix',
    statement:
      'If the fix is behind a flag, the code path proves the flag was on in the fixed capture.',
    answer: false,
    why: 'Whether the flag was on is a fact about the capture, not the code. Read it out of the heap.',
    check: '`memlab_app_config` with the flag key on each arm.',
  },
];

export const FIX_TOPICS: string[] = [
  ...new Set(FIX_QUESTIONS.map(q => q.topic)),
];

export function questionsFor(topics: string[] | undefined): FixQuestion[] {
  if (topics == null || topics.length === 0) return FIX_QUESTIONS;
  const wanted = new Set(topics);
  return FIX_QUESTIONS.filter(q => wanted.has(q.topic));
}

/**
 * The fix that has worked for a leak family, with the test that catches its
 * usual mistake. Printed by `memlab_fix_knowledge_check({action: "pattern"})`
 * and pointed at by the tools that detect each family, so a fix starts from
 * the known shape instead of being re-derived.
 */
export interface FixPattern {
  id: string;
  family: string;
  /** What the detecting tool shows. */
  signal: string;
  fix: string[];
  test: string;
  /** `FIX_QUESTIONS` ids worth answering before writing it. */
  questions: string[];
}

export const FIX_PATTERNS: FixPattern[] = [
  {
    id: 'noop-setstate',
    family: 'React eager-bailout records (no-op `setState`)',
    signal:
      '`memlab_react_update_queues` lists the component under "No-op `setState` sites": records grow linearly and every pending record is the value already rendered.',
    fix: [
      'Guard the call: skip the setter when the value equals the last value SET. Keep that value in a ref the guard alone writes (`if (last.current === next) return; last.current = next; setX(next);`).',
      'Do not compare against rendered state or a ref the render also writes: inside one batch it lags the queued value.',
      'Put the guard behind a feature flag, so one A/B round can size it.',
    ],
    test: 'A change and a change back in one batch (`setX(a); setX(b)` with `b` the current value) must still render `b`. A guard reading rendered state drops the second call. Then `memlab_verify_fix({metric_kind: "pending_chain"})` on both arms: records per cycle should drop to 0.',
    questions: ['gate-on-in-capture', 'partial-fix'],
  },
  {
    id: 'listener-per-mount',
    family: 'A listener added per mounted instance and never removed',
    signal:
      '`memlab_event_listener_leaks` reports orphaned contexts (retained only by listener registrations) or duplicate callbacks, growing with the number of mounts.',
    fix: [
      "Add the listener in an effect and remove it in that effect's cleanup, passing the same function object to both calls.",
      'For a window- or document-level listener that every instance adds, register one shared listener and keep the mounted instances in a set it dispatches to.',
    ],
    test: 'Mount and unmount the component N times, then count listeners on the target (`memlab_event_registry`): the count returns to its baseline.',
    questions: ['listener-reference', 'effect-cleanup'],
  },
  {
    id: 'memo-cache-strand',
    family: 'A stale value kept in a React Compiler memo cache',
    signal:
      'A retainer path through `updateQueue.memoCache.data[i][j]` to a detached element or an old object, typically bounded at one copy per mounted component.',
    fix: [
      "The compiler caches values made during render, including the initial value passed to `useRef` or `useState`. Replacing the value later leaves the first one in its cache slot for the component's lifetime.",
      'Keep the identity and change it in place (truncate the array, clear the map) instead of assigning a new copy, or build the initial value lazily.',
    ],
    test: 'A ladder shows nothing for a bounded leak. Compare detached-node counts over several reload pairs, with the fix off and on, after the same first mount.',
    questions: ['react-compiler-closures', 'react-null-state'],
  },
];

export function fixPatternFor(id: string): FixPattern | undefined {
  return FIX_PATTERNS.find(p => p.id === id);
}

/** One line a detecting tool prints under a finding of this family. */
export function fixPatternPointer(id: string): string {
  return `_Known fix shape for this family: \`memlab_fix_knowledge_check({action: "pattern", family: "${id}"})\`._`;
}

/** The family a printed retainer path belongs to, when it names one. */
export function pathFixPattern(pathText: string): string | null {
  return /\bmemoCache\b/.test(pathText) ? 'memo-cache-strand' : null;
}
