---
title: "Who owns the growth / why is X retained?"
description: "Who owns the growth / why is X retained?"
sidebar_label: Retention
sidebar_position: 3
custom_edit_url: null
---

These tools are in the `retention` toolset. Starting the server with
`MEMLAB_TOOLSETS=retention` exposes only them, plus the few tools every
session needs, and `memlab_tools({enable: "retention"})` turns them on
in a session. Try them in the order listed.

| Tool | Use it when |
| --- | --- |
| `memlab_react_owners` | Name the React COMPONENT behind a population of plain `Object`s. Fibers and hooks are all `Object` in a production bundle, so every class-name heuristic — including `helpers.owner` — walks past them. |
| `memlab_react_stale_refs` | Live React state pointing at dead UI: effect cleanups on MOUNTED fibers that captured now-detached DOM (grouped by component and variable, with hook scope and module), and Map/Set/object registries holding scope instances, DOM nodes or fibers of UNMOUNTED components, with bytes freed by deleting them. |
| `memlab_population_vs_owners` | STRUCTURAL or ACCUMULATING? One record per live owner is a baseline; many records per owner is a leak. |
| `memlab_chain_walk` | Walk a repeated linked structure (`.next` update queues, `.prev` closure chains, LRU lists) and report how deep it goes — use this instead of a hand-written loop, which cannot tell a cycle from a hop cap. |
| `memlab_module_attribution` | Attribute bytes to the MODULE that owns them, by walking dominators up to the nearest module-registry export. |
| `memlab_census` | Count several named populations (detached DOM, listener records, LRU cache nodes, React fibers, timers, …) across every rung in ONE pass each, with per-cycle rates and a settle verdict. |
| `memlab_ab_compare` | Judge an A/B round in one call: the same probes on the OFF and ON arms, per-cycle rates, ON/OFF ratio and a FIX EFFECTIVE / NO EFFECT / CANNOT JUDGE verdict per metric, plus each arm's heap total with dev-only memory removed. Each arm's first (warm-up) rung is left out of the fit by default. |
| `memlab_object_urls` | Unrevoked `blob:` object URLs per rung — their Blobs are pinned OFF the V8 heap, so this leak never shows in heap size. |
| `memlab_cache_sole_retainer` | Module-level caches counted by the objects that ONLY caches keep alive (reachability with every cache refused): objects the app let go; per-cycle growth across a ladder. |
| `memlab_bound_functions` | Bound functions (`native_bind`) grouped by target function and module, receiver or first bound argument (a React setter names its component), and holder; per-cycle growth across a ladder. |
| `memlab_rate_table` | Rank several rounds by the per-cycle rate of ONE population, labelled by the surface each round drove — the "which surface do I fix first" table. Carries settle-drain and isolate-age columns, because a rate is not comparable without them. |
| `memlab_external_strings` | Attribute `system / ExternalStringData` — usually the largest class in a browser heap, and the one a retainer trace cannot explain. Names the source chunks by reading their content. |
| `memlab_explain_delta` | WHERE a heap grew, attributed to the object that owns the new bytes rather than to what they are. Production-only by default; flags a backing store that grew by a one-time capacity step. |
| `memlab_dominator_chain` | From one node up to the accountable application object. |
| `memlab_dominator_attribution` | Given several candidate retainers, how much each one actually dominates — a zero refutes a hypothesis. |
| `memlab_allocation_sites` | WHO allocated these objects: live objects grouped by the JavaScript stack that allocated them (needs a capture recorded with allocation tracking, e.g. a `.heaptimeline`). |
| `memlab_retained_by` | Bytes retained ONLY through closure contexts, detached DOM, the DevTools console or event handlers: what removing every such retainer would free, with the largest classes. Filter any query or histogram the same way with `retained_by`. |
| `memlab_dead_context_variables` | Captured variables no live code can read, heap-wide: a value kept alive only because it shares a closure Context with a sibling closure that is still alive. Needs a V8 15.6+ (Chrome 156+) capture. |
| `memlab_probes` | Save an app's probes once (code, `cap`, `expect` flat/bounded) in a named set; `ladder_probe`, `ab_compare` and the battery run a set whose `match` is in the round's URL filter, with OK / VIOLATED per probe. |
| `memlab_element_census` | Retained React elements and fibers by component: fibers mounted / alternate / detached, elements by holder (mounted tree, closure, update queue, dev debug field…); per-rung growth with `run_dir`. |
| `memlab_fiber_census` | What the mounted React tree is made of per list item: rendered vs collapsed/virtualized items by subtree size, and each heavy child type per rendered item ("44 per item × 32 items"), with removal bytes; per-snapshot deltas with `paths`. |
| `memlab_error_callsites` | Where retained Error objects were created, from the stack frames V8 captured (survives a truncated `.stack`); groups by top frames, names the JSX site of React `_debugStack` Errors. |
| `memlab_retained_errors` | Retained Errors and error text by message template, with first app frame and whether only the DevTools console holds them; with `run_dir` the change per cycle and templates new since the first rung. |
| `memlab_model_duplicates` | Records that share an identity value (`identity_path`, e.g. `__x_id._serialized`): copies of a one-per-id model, where the extras are held and what they retain; per-rung counts with `run_dir`. |
| `memlab_scope_chains` | Chains of contexts of one function, each call pinning the previous call's scope through a captured closure: invisible to class counts. Flags the React Compiler dev hook-guard artifact (links only through `t0`..`tN`); per-rung lengths with `run_dir`. |
| `memlab_retainer_trace` | The shortest retainer path for one node; `mode: "tree"` shows every owner as a bounded tree (`max_depth`, `max_nodes`, `max_siblings`) ending at a root or the page global. A repeating multi-hop chain prints once with its count. On a minified build the path starts at the module holding the object; `raw: true` shows the registry hops above it. |
| `memlab_retainer_summary` | Retainer paths across many instances, clustered by shape. On a minified build each pattern starts at the holding module; `raw: true` keeps the registry hops. |
| `memlab_referrer_summary` | Who points at this, grouped by edge. |
| `memlab_pinch_points` | Single objects whose release would free the most. |
| `memlab_dominator_subtree` | What one object holds, expanded downward. |
| `memlab_retainer_layers` | The retention structure around a node, layer by layer. |
| `memlab_trace_dominators` | Dominator path for a set of nodes at once. |
