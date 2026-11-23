---
title: "Is anything growing — and is it a leak?"
description: "Is anything growing — and is it a leak?"
sidebar_label: Growth and leaks
sidebar_position: 2
custom_edit_url: null
---

These tools are in the `growth` toolset. Starting the server with
`MEMLAB_TOOLSETS=growth` exposes only them, plus the few tools every
session needs, and `memlab_tools({enable: "growth"})` turns them on
in a session. Try them in the order listed.

| Tool | Use it when |
| --- | --- |
| `memlab_ladder_probe` | ONE numeric probe across an ordered ladder, with the per-cycle rate and a linear fit — the cheapest way to test a metric, since each rung loads once for all probes. |
| `memlab_rate_model` | Unbounded leak, or a working set whose size is just rate x window? Fits a line AND a saturating curve to one series and reports which the data supports, plus the implied plateau. |
| `memlab_build_pair_compare` | A dev-build round and a production-build round of the same combo, lined up per population by property set and unmangled class: dev-only, production-real, production-saturating or production-only, and how much of the dev heap growth a production build keeps. |
| `memlab_code_diff` | Did a build change make functions BIGGER, or did V8 just compile more of them in this capture? Per-function bytecode A/B joined by name + script: same-function growth (components vs others), compile-state flips, and unmatched functions, with the net code delta split between them. |
| `memlab_compare_rounds` | Compare N rounds of a sweep: rates that land on a WHOLE NUMBER per cycle or per landed step, with the step they match (a mechanism, not a trend), and populations that grew while app_delta was negative (invisible to the aggregate ladder). Takes round names from the shared round index too. |
| `memlab_field_release_impact` | If a fix nulls this property, how many bytes come back — and is it the only reference? The question every memory fix asks, in the form fixes actually take. |
| `memlab_analysis_battery` | Run a whole round's analysis in one call, write per-tool detail to disk, return only a digest — the way to read a multi-round sweep without spending a context window on it. With `async: true` it runs in a child server process, so the server stays responsive. |
| `memlab_retention_windows` | What windows could BOUND this population — timeouts, TTLs, cleanup intervals? Run it before calling any growth unbounded: a ladder shorter than the app's window cannot tell a leak from a working set. |
| `memlab_prune_run` | Reclaim the disk a round occupies by gzipping its rungs (still analysable) or deleting them. A sweep is tens of GB. |
| `memlab_battery_status` | Wait on a `memlab_analysis_battery({async: true})` run (`wait_ms`, up to 90 s) and collect its report when it finishes. While it runs, the reply quotes the digest of the steps already done; `battery.partial.json` holds the same, and `battery.done.json` is written last. |
| `memlab_start_job` | Run ANY tool in the background and get a job id at once — for ladder tools that would outlive the client tool timeout. |
| `memlab_positive_controls` | Measure the round's declared positive controls — known accumulators — so a flat result can be trusted as clean rather than blind. Finds a control by value shape on a minified build, and says UNRESOLVED when it cannot. |
| `memlab_synthetic_controls` | Did a sizing round SEE its synthetic leak (`--synthetic-leak-kb`) at the injected rate and leave its synthetic plateau (`--synthetic-plateau-cap`) flat? App-independent positive and negative controls, plus the smallest total-heap growth per cycle the ladder can tell from noise. |
| `memlab_judges` | Judge a round against its stated invariants at rest — PASS / LEAK / BACKLOG / UNSETTLED / UNVERIFIED per plain-words claim, every probe on every rung and the settle rung in one pass. |
| `memlab_switch_matrix` | Can each judge go red? Judge rounds (or the two phases of a `--ab` round) with named fixes switched off: a judge that stays green with its fix off is BLIND. |
| `memlab_calibrate_judges` | Prove judges against rounds KNOWN to carry the leaks they guard; records who has been seen red, so `memlab_judges` can mark every unproven PASS. |
| `memlab_cache_inventory` | Module-scope Maps/Sets/Arrays ranked by what their entries hold, with the owning module and any clear/reset API it already has — memory-pressure candidates in one call. |
| `memlab_module_source` | The served source of one module (`__d` span) read from the snapshot: is the fix served (`gate`), is it a dev-compile artifact (`compare_to` a prod capture), what does it do (`grep`). |
| `memlab_source_for_node` | Which module's code a node belongs to (closure scope chain → Haste module, exact), for going from "which object" to "which file" without code search. `context_lines` also prints the function's definition from the served source, and a context's variables and closures. |
| `memlab_source_for_finding` | A finding's likely source files: the module names on its retainer path resolved to files (with `MEMLAB_SOURCE_LOOKUP_CMD`), and in each the lines that assign the path's field names. |
| `memlab_stale_refs` | React refs whose `.current` is detached DOM, by owner and variable, against the owner's fiber count — bounded (≤1 per instance) or accumulating. |
| `memlab_dev_subtracted_delta` | Per-class growth between two snapshots with everything reachable only through a dev root or dev edge removed — the dev build's honest "what did the app grow". |
| `memlab_job_status` | Poll a `memlab_start_job` job: per-rung notes while it runs, the full result when it is done. `wait_ms` (up to 90 s) waits for it to finish. |
| `memlab_shape_census_diff` | Per-SHAPE growth across the ladder. Reach for this the moment a class-level tool blames `Object`: it turns "`Object` +377,959" into "`{event,timestamp}` ~0 → 53,029" in one call. |
| `memlab_census_diff` | Detached-DOM and listener census at TWO rungs, diffed per class and per callback in one call. |
| `memlab_leak_report` | The ladder verdict: per-class growth across an ordered set of snapshots; SATURATING (warm-up) and STEP+LINEAR (post-step rate) rows are told apart from linear growth, and rows that grow by one shared unit are grouped. With `run_dir`, a round that sampled between rungs gets a "Between rungs" section that flags a heap rising with no requests, a request storm, or a runaway stop. `families` (or run.json `families_file`) labels the growth an earlier round already explained and counts what is NEW. `Object` growth is split by property shape, each shape with the module holding its newest instances. A `system / ExternalStringData` row that is mostly script source reads 📦 CODE LOADED (or bundle DUPLICATION) and is not a leak candidate. |
| `memlab_growth_cohort` | Who holds the NEWEST instances — the tail of the id range IS the growth. Reports it next to the whole population, so a static collection masking an accumulating one is visible in one call. `group_by: "referrer+shape"` splits an `Object` cohort into (holder, record type) rows, with counts on a `baseline_path` rung. |
| `memlab_sequence_analysis` | Per-class trend across a ladder, with artifact families flagged. |
| `memlab_collection_trend` | Entry counts of NAMED collections across a ladder, with growth per interaction cycle. |
| `memlab_growth_check` | Before writing "grows" about one holder: the same object on every rung, and whether it grows, is frozen, turns over or shrinks. |
| `memlab_population_diff` | Whether two snapshots hold the same POPULATION or just the same count — equal totals are not identity. |
| `memlab_react_update_queues` | The React eager-bailout family in one call: queue BREADTH vs chain LENGTH vs owning component. The breadth/length split is what separates a leak from "more hooks mounted". Maps each hook to its `useState` line and setter call sites in the served source, lists every eager-bailout site as `setter(value) @ Component`, and names minified components by module. Over a ladder, names the setter of each growing component and flags the linearly growing no-op `setState` sites to guard. |
| `memlab_settle_check` | Backlog or leak? Compares a busy rung against one captured after idle + GC — growth that comes back was work in flight. With `run_dir`, also prints how long the idle ran and whether it stopped early once post-GC heap went quiet. |
| `memlab_growth_signals` | Single-snapshot signals that something is accumulating. |
| `memlab_diff_snapshots` | Per-class deltas between two snapshots. For two captures of one tab session (same V8 isolate, detected automatically) it also matches objects by id: per class, how many are new and still alive, how many were freed, and their bytes, so churn no longer reads as zero. `class_name` + `detail` ("added" or "deleted") lists those objects, paged. |
| `memlab_hypothesis` | Test MANY predicates against every rung in ONE pass each, with an `expect` per predicate for a PASS/FAIL column. Use it instead of hand-writing a `memlab_eval` per theory — a second forEach over a multi-million-node graph aborts on the cumulative node budget. `watch: true` keeps them for the sweep, and each later battery reports which ones flipped. |
| `memlab_verify_fix` | Did the fix work? Compares per-cycle growth RATES between a before ladder and an after ladder — from two sets of snapshot FILES, so no runtime gate is needed and an ungated or build-only fix is verified the same way. Each rate is a slope over every rung with a 95% interval, and the verdict is FIX CONFIRMED, FIX FALLS SHORT or INCONCLUSIVE (with the reason and the reduction the run could confirm). `before_repeat_paths` adds a second ladder of the unfixed build, whose spread widens the interval; with `setup_name` that spread is recorded once and reused by later checks on the same setup. A setup check reads each round's run.json and withholds the verdict when the code, isolate, build kind or browser changed. `second_pair` reads the verdict off two pairs and reports whether their order cancels drift. |
| `memlab_fix_knowledge_check` | Before writing a fix: true/false questions on the beliefs that most often send a leak fix the wrong way (WeakMap hops, React alternate fibers, shared closure contexts, caches filling up, dev-only chains), graded with the reason and what to measure. `action: "pattern"` gives the known fix and its test for a leak family (no-op `setState`, listener per mount, memo-cache strand). |
| `memlab_ladder` | Name a ladder once and reference it as `ladder:<name>` from every trend tool. |
