---
title: Snapshot Ladders
---

A single snapshot can't tell you whether memory grows. For that, the growth
tools work on a *ladder*: an ordered series of snapshots (*rungs*) taken
while one interaction repeats, for example a snapshot after every few times
a dialog opens and closes.

Most ladder tools load each rung only for as long as they need it, so a long
ladder doesn't have to fit in memory at once.

## Give the Server a Ladder

A ladder can be given in three ways:

- **`paths`:** an ordered list of snapshot files. If the files are named
  `rung_NN_cNNN.heapsnapshot`, the number of repetitions (cycles) at each
  rung is read from the name. Otherwise the rungs are taken to be evenly
  spaced, and the report says so.
- **`run_dir`:** a directory whose `run.json` lists the rungs, the cycles
  driven at each one, and optionally a *settle* rung, taken after the page was
  idle and garbage-collected. The settle rung is what tells a leak apart from
  work that is still in progress.
- **`ladder:<name>`:** a name registered once with `memlab_ladder`.

## Find What Grows

A typical ladder investigation, in conversation:

1. **Find what grows:** "Which classes and shapes grow every cycle?"
   (`memlab_leak_report`, `memlab_shape_census_diff`, `memlab_collection_diff`)
2. **Tell a leak from a working set or a backlog:** "Does this growth level
   off, and does the settle rung give it back?" (`memlab_rate_model`,
   `memlab_settle_check`, `memlab_retention_windows`)
3. **Find the owner:** "Who holds the newest instances?"
   (`memlab_growth_cohort`, `memlab_trace_all`, `memlab_react_owners`)
4. **Size the fix:** "How many bytes come back if this property is cleared?"
   (`memlab_field_release_impact`, `memlab_what_if`)
5. **Verify the fix:** "Compare the ladders from before and after the fix."
   (`memlab_verify_fix`, `memlab_replicate`)

[Reading the Numbers](./reading-the-numbers.md#how-growth-is-classified)
explains how `memlab_leak_report` tells warm-up and one-time growth from a
leak.

## Run Several Analyses at Once

`memlab_analysis_battery` runs a set of ladder analyses over the same rungs,
and writes a digest of their results. It keeps rungs parsed between its steps
while memory allows (`MEMLAB_RETAIN_RUNGS` caps how many).

### Follow a Battery's Progress

- After each step, the battery rewrites `battery.partial.json` with the
  results so far, so you can read the first ones while a slow step runs.
- It writes `battery.done.json` to its output directory last, so a script can
  wait for that one file.
- From the assistant, `memlab_battery_status({battery_id, wait_ms})` waits for
  it.
- With `async: true`, the battery runs in a separate copy of the server by
  default (`isolate`), so the server keeps answering other calls.
- `wait_for_rungs: "all"` holds a battery until the round's `round.done` marker
  appears.

### What Every Battery Measures

Besides its analyses, every battery counts populations that grow outside the
JavaScript heap, where analyses ranked by size don't notice them:

- **User content:** `files`, `blobs`, `blob_urls`, `abort_controllers` and
  `media_handles` per rung. A discarded attachment that stays reachable adds
  one per attempt, while its bytes sit outside the heap.
- **Native browser objects:** `memlab_blink_native_census` counts native
  (Blink) objects per rung and rates a fixed list of browser holders that
  have no cap, such as performance entries, User Timing marks, style caches
  and observer registrations. It is left out on A/B rounds.
- **Workers:** when the round recorded
  `performance.measureUserAgentSpecificMemory()` per rung (the page must be
  cross-origin isolated), the digest gives its first and last value, with the
  dedicated workers' share. Workers and WebAssembly are in no page snapshot,
  so this is the only place their growth shows. Without it, the digest gives
  the workers' JS heap size read over the DevTools protocol instead.

Once per sweep (the round directories that share a parent), a `standard`
battery also scans the final rung for sparse element stores, duplicated
strings and duplicated objects: on the first round, and again when a round's final rung
is at least 25% larger than any scanned so far.

### Read the Digest

- The digest ends with the next calls worth making for that round. A call
  already suggested for the same class in an earlier round of the sweep is
  only named, not repeated.
- `memlab_round_audit` checks the round itself. A check that an earlier round
  of the sweep showed word for word is folded into one "N check(s) unchanged
  since …" line; the verdict always shows. The audit also names each recorded
  fix whose `fixed_behind` flag the build doesn't serve, because that round
  ran without the fix.
- The audit verdict is about the round, not the sweep. An environment caveat
  the previous round already had (the same unserved-flag list, a warm isolate)
  is marked "unchanged since rN" and doesn't make the round CAVEATED. In an
  A/B round, the reload between the two arms is expected: each arm must be
  continuous and have at least 2 rungs.
- `memlab_hypothesis({run_dir, predicates, watch: true})` keeps predicates for
  the rest of the sweep. Every later battery checks them again and names any
  whose PASS or FAIL changed since the previous round. `unwatch: [label]`
  drops one.

### A/B Rounds

When a round compares two arms (its `run.json` has an `ab` section and the
ladder splits between them), the battery runs each step once per arm, writes
`<tool>.off.txt` and `<tool>.on.txt`, and adds a `memlab_ab_compare` verdict
table. The table always has rows for React state-update records (what a fix
for `setState` calls that change nothing removes), and for `files`, `blobs`
and `blob_urls`.

Each arm starts on a freshly loaded page, so `memlab_ab_compare` leaves out
each arm's first rung by default (`skip_intervals`) and prints the rate over
all rungs beside it. When leaving out that warm-up changes the verdict, the
verdict says so.

## Growth Outside the JavaScript Heap

Some leaks are invisible in every heap figure. These tools find them:

- **`memlab_hunt_report`** lists off-heap numbers per rung, with the browser
  process's memory beside the renderer's when the run recorded it, and flags
  growth that outpaces the JS heap. Live object URLs, for example, keep their
  Blob bytes in the browser process.
- **`memlab_object_urls`** counts `blob:` URLs that were never revoked. When
  the run traced `URL.createObjectURL`, it also ranks the calling code by
  growth and prints the stack of the fastest-growing caller.
- **`memlab_pending_promises`** shows the native memory behind promises that
  never settle. Chrome keeps task-attribution state for every `.then`
  reaction, about 1 KB each, which no JavaScript retainer path shows.

## Who Holds the Growth

- **`memlab_cache_sole_retainer`** finds objects that only caches keep alive:
  objects the app has let go of. It computes what is reachable twice, once
  without passing through module-level caches (a `Map` or `Set` held by a
  module scope, an exported function, or a memoizer object), and attributes
  the difference to those caches. Over a ladder, it ranks caches by such
  objects gained per cycle.
- **`memlab_bound_functions`** explains growth in the `native_bind` row of a
  class count: V8 names every `fn.bind(...)` result `native_bind`. It groups
  bound functions by target function and module, by receiver or first bound
  argument (a React `useState` setter is bound to its fiber, which names the
  component), and by the reference that holds them, then ranks the groups by
  growth per cycle.

## Run One Query on Every Rung

`memlab_eval_across` runs one `memlab_eval` program on each rung, without
loading the rungs first. Give it `paths`, or a `run_dir` with
`rungs: [0, -1]`. With `format: "table"`, when each rung returns a number or
a flat object of numbers, the answer is one table with a column per rung and
the change from first to last.

Both eval tools also take:

- `code_file`, a `.js` file to run instead of inline `code`.
- `use`, a list of probe sets whose `prelude` runs first. Save setup that
  every probe repeats once, with `memlab_probes({mode: "save", set, prelude})`.
  With `use` and no `code`, `memlab_eval_across` runs the sets' probes
  themselves, one row per probe. It uses the set's saved `run_dir` when you
  pass no `run_dir`, `paths` or `handles`.

See [Advanced Analysis](./advanced-analysis.md#custom-queries) for what eval
programs can do.

## Compare a Development and a Production Build

`memlab_build_pair_compare({dev_run_dir, prod_run_dir})` lines up a round on a
development build with one on a production build. Field names survive
minification, so populations are matched by their set of properties (and by
class where the name isn't minified). Each population is reported as:

- **dev-only:** it grows only on the development build.
- **production-real:** it grows on the production build too.
- **production-saturating:** it grows on the development build, but the
  second half of the production round grows less than 20% as fast as its
  first half, so on production it is bounded.
- **production-only:** it grows only on the production build.

The summary says how much of the development build's growth per cycle the
production build keeps.

## Faster Repeat Analyses

The first time a rung is loaded, the server writes an index file next to it
(`<snapshot>.memlab-index.json`) with class counts, reference names and shape
tables. Later ladder calls read the index instead of parsing the rung again:
`memlab_shape_census_diff` with no filter takes seconds over a ladder that
already has them.

## Long-Running Analyses

Ladder analyses can take longer than the assistant waits for a tool call.

- **Background jobs.** Start a tool with `memlab_start_job` and collect the
  result with `memlab_job_status`. `memlab_load_snapshot({async: true})` and
  `memlab_eval_across({async: true})` run in the background too.
- **Waiting.** `memlab_job_status` and `memlab_battery_status` take `wait_ms`,
  up to 90 seconds, so the call returns before a client gives up on it. A
  RUNNING reply says when it was written, so a late reply reads as stale.
- **Time limit.** Every call runs under a 90-second limit by default, longer
  on heaps over 10 million nodes (9 µs per node). Every tool takes `timeout_ms`
  to change it for one call, and `MEMLAB_ANALYSIS_TIMEOUT_MS` changes it for
  all calls. A scan that runs past it returns "analysis stopped" instead of
  blocking the server. `memlab_sweep` gives each section its own limit and
  lists the sections that ran out.
- **Jobs survive restarts.** Job handles are written to `~/.memlab/jobs/`
  (`MEMLAB_STATE_DIR`), so a restarted server, or a second one, still answers
  for them: with the result, "running in another memlab server", or ORPHANED
  if the process running the job exited before it finished.

The server also frees memory on its own:

- After 30 idle minutes, a long-running server unloads every snapshot except
  the active one (`MEMLAB_IDLE_UNLOAD_MIN` changes the delay).
- With `MEMLAB_RSS_SOFT_CAP_MB` set, it unloads the snapshot used least
  recently, once a minute, while its memory use is above that cap.
- `memlab_server_status({all: true})` lists every memlab server process on
  the machine, with its parent, memory use and age, so a forgotten server
  holding gigabytes is easy to find.
