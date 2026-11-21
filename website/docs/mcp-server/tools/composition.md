---
title: "What is this heap actually made of?"
description: "What is this heap actually made of?"
sidebar_label: Heap composition
sidebar_position: 1
custom_edit_url: null
---

These tools are in the `composition` toolset. Starting the server with
`MEMLAB_TOOLSETS=composition` exposes only them, plus the few tools every
session needs, and `memlab_tools({enable: "composition"})` turns them on
in a session. Try them in the order listed.

| Tool | Use it when |
| --- | --- |
| `memlab_script_census` | How much of the heap is retained JS SOURCE TEXT — and whether the same bundle is retained twice. |
| `memlab_property_names` | Which property names exist at all; the cheapest way to confirm a field is present before probing for it. |
| `memlab_async_census` | Pending async work: scheduler task queues (live vs cancelled), timer closures, unsettled Promises. |
| `memlab_pending_promises` | Unsettled Promises ranked by reaction-chain length, tracked across a ladder by id or owner path — one never-settling promise gaining `.then`s per cycle — with the Blink task-attribution / soft-navigation memory each reaction keeps alive. |
| `memlab_sweep` | Every first-pass lead in ONE call after loading: top retained with holder, dead collections, string families, flagged framework buffers, largest class by holder, async/Node flags, ladder growth with 2+ snapshots, and a ready-to-paste memlab_residual call. |
| `memlab_app_heap` | START HERE on an unfamiliar app: splits the heap into application data vs bundle source vs V8 machinery. On one app this showed ~55% of the heap was JS bundle source, which reframed every number that followed. |
| `memlab_memory_partition` | "What is using the memory?" in one exclusive table: framework families (React, collections, telemetry records, module system, memo caches, Wasm), DOM/Blink sub-families, and the rest by the module or global on its shortest path. Works minified. |
| `memlab_path_tree` | WHERE the memory sits, as a tree: shortest-path subtrees with byte sums (they partition the heap, so shared caches show their real size), expanded wherever a branch is big. |
| `memlab_model_census` | What ONE loaded record costs, per model type in Backbone-style collections: fields, V8 property store, arrays held, retained per record, plus each `_index` dictionary. Works minified. |
| `memlab_timers` | Pending scheduler tasks grouped by the real callback and the payload it captures — a timer per record keeps the record alive for its whole delay. |
| `memlab_framework_buffers` | The recurring framework buffers in one call: log arrays, module timing records, lazy-loader registry, scheduler queue, registry tables, giant objects, plus app-specific buffers from a probe file. |
| `memlab_capture` | Take fresh snapshots of a live page AND its dedicated workers (a page snapshot never contains them). Skips threads blocked in Atomics.wait instead of hanging. |
| `memlab_live_eval` | Evaluate one expression in the live page and return its JSON value, with a deadline; side-effect-free expressions only unless allowed. Checks a snapshot hypothesis against the running app. |
| `memlab_native_contexts` | Split ONE snapshot by realm (page, iframes, extension worlds, detached windows, Node `vm` contexts): bytes each NativeContext owns alone, shared bytes, unattributed bytes, and the largest classes in any of them. |
| `memlab_node_server` | Node.js server heaps: `require.cache` entries ranked by what their exports retain, IncomingMessage / ServerResponse / Socket / Timeout counts with lifecycle flags, and the sockets and timers carrying AsyncLocalStorage request stores, with their routes; who strongly holds each extra `vm` realm (Map and key), and chunks loaded but never evaluated. |
| `memlab_realm_summary` | Page + worker snapshots side by side: app / bundle / code per realm, with shared Wasm modules and SharedArrayBuffers counted once. |
| `memlab_co_holders` | Clusters of Maps/Sets/Arrays holding the same objects, with bytes freed by cutting one holder vs all of them. |
| `memlab_realm_duplication` | Modules loaded in more than one realm (page + workers), with state bytes per realm and the duplicated total. |
| `memlab_quick_diagnosis` | One call for summary + biggest objects + class histogram + duplicated strings + string families (≥1 MB). |
| `memlab_snapshot_summary` | Node/edge counts, totals and the standard statistics split (V8 heap: code, strings, JS arrays, system; native: typed arrays), including native memory with no node (`extra_native_bytes`). |
| `memlab_class_histogram` | Counts and sizes per class; `name_pattern` answers "is class X present?" in one row. |
| `memlab_largest_objects` | The single biggest retainers, ranked. |
| `memlab_shape_histogram` | Groups plain objects by their property set — finds record types the class name hides behind `Object`. |
| `memlab_identify` | Name a minified structure from its property shape — listener record, LRU node, React update record, undo entry. |
| `memlab_object_cost_breakdown` | Where one class’s bytes actually go (self vs properties vs elements). |
| `memlab_what_if` | If this set were freed, how many bytes actually come back — dominator-deduped, no double counting. Select by ids, class, typename, shape, or `scope_of` (every context of one function scope, a whole scope chain). |
| `memlab_residual` | Cut every explained finding at once and census what is still reachable: bytes each cut frees alone and together (with overlap), top remaining dominators, holder `Class.edge` groups, heap-number holders, arrays over 100 KB. Finds the long tail after the big items. |
| `memlab_trace_all` | Retainer-trace an ENTIRE population and cluster the paths server-side — finds the minority path a 10-instance sample cannot. Clusters past `limit` are listed one line each, as path shapes. |
| `memlab_retainer_diff` | Did the population grow along the same retention path, or did a NEW owner appear? The question a count diff cannot answer. |
| `memlab_identity_diff` | Same objects, or just the same count? Matches a population across two captures by CONTENT — churn and retention need different fixes. |
| `memlab_next_measurement` | What the loaded snapshots cannot support, and which capture would fix it. Run it before writing a conclusion. |
| `memlab_app_config` | Read the feature flags the app was actually running with, out of the capture — "was the fix even enabled here?" without circular inference. |
| `memlab_gate_fingerprint` | Which experiment ARM a capture is in, when the gate is server-side-scoped and `memlab_app_config` has no flag to read — reads the arm from a population the other arm does not build. |
| `memlab_metric` | Record a measurement under a name and keep it ACROSS sessions — the only way a number measured today survives to be compared next week. |
| `memlab_unit_cost` | Retained bytes per instance, AVERAGE and MARGINAL — the number a cap, an LRU size or an eviction policy is sized against. |
| `memlab_snapshot_budget_planner` | Which rungs of a ladder fit in memory at once, and which to probe transiently — answers "can I afford the MARGINAL unit cost?" before an analysis discovers the ceiling by hitting it. |
| `memlab_island_doors` | List EVERY production-reachable reference into a detached island, not just the shortest one — a fix that closes one of several holders reclaims nothing. |
| `memlab_build_provenance` | Assert the snapshot came from a build that actually contains the change, before reading any before/after number — "the fix does not work" and "the fix was never built" otherwise look identical. |
| `memlab_console_retention` | Report what an attached DevTools console is keeping alive, and whether a given object depends on it — console-held roots are real GC roots in the capture that do not exist in production. |
| `memlab_count_population` | Count one population by class, by shape AND by closure-captured variable, and flag when the methods disagree — a method that cannot reach a population returns the same 0 as a population that is absent. |
| `memlab_drill_to_heavy_leaf` | Follow a big retained size DOWN to the object actually holding it in ONE call, instead of walking dominator_subtree hop by hop — stops at the leaf or the branch point where the weight splits. |
| `memlab_overlap_matrix` | Do these classes retain the SAME bytes? Use it before adding two per-class retained sizes together — classes on one retention chain share bytes and the sum double-counts them. |
