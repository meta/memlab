---
title: Reading the Numbers
---

memlab and the Chrome DevTools heap profiler read the same snapshot, but a
few figures are defined or grouped differently. memlab's reports also
classify growth and fold long results in ways worth knowing before you read
them.

## Compared with Chrome DevTools

| memlab | Chrome DevTools |
| --- | --- |
| **Self size** | *Shallow size* |
| **Retained size** of an object | Same definition (from the dominator tree) |
| **Class retained size** (`memlab_class_histogram` with `include_retained_size`) counts each byte once, even when instances hold one another | Same as the profiler's constructor rows. In both, rows overlap across classes, so they don't add up down the table |
| **Class keys** are `type::name`, such as `closure::onClick` or `object::Map` | Grouped by constructor name, with `(closure)`, `(string)`, `(array)` and `(system)` groups |
| **Total** is the root's retained size plus `extra_native_bytes` | Same |
| **Distance** and **detachedness** (`memlab_get_node`) | Same: hops from the root, with page globals at 1; attached, detached or unknown |

By default, memlab's lists leave out engine-internal node types (arrays,
code, native and synthetic nodes). Ask for them by `node_type`.

## How Growth Is Classified

`memlab_leak_report` doesn't count every growing class as a leak:

- **`SATURATING`:** a class that grows at every rung, but by less each time
  (preloading, things loaded on first open). Once its last step adds under
  20% of what its first step did, it is not a leak candidate.
- **`ONE-TIME`:** a class with at least 80% of its growth in one step, and
  less than `min_growth_count` over the other steps. Not a leak candidate
  either.
- **`STEP+LINEAR`:** a jump (such as a first mount) followed by steady
  growth. The rate after the jump is the leak rate; the overall change per
  cycle overstates it.
- **Rows that grow together are one leak.** Rows whose change is the same, or
  a whole multiple of it, at every step are grouped. A leaked subtree, for
  example, shows up as a detached element, the listener holding it and the
  scope holding the listener, each growing once per cycle. The group says to
  trace one of them.

Other tools apply similar rules:

- `memlab_settle_check` says "grew further at rest" only when a class gained
  more than 10% of its growth (and more than two instances) between the last
  busy rung and the settle rung.
- **A whole-number rate points to a cause.** `memlab_compare_rounds` lists
  every population whose rate is a whole number per cycle, or per step the
  round drove, with the step it matches. For example, an interaction that
  opens two chats per cycle shows 2.000 per cycle for one record per opened
  chat, and the table says `1 per open-chat`.
- **Bounded windows are reported apart.** A collection that the app empties
  on a timer (a 30-minute trace buffer, a cache with an expiry) fills for as
  long as its window lasts, so on a short ladder it looks like steady app
  growth. `memlab_artifact_budget({windows: [{name, edge, value_keys}]})`
  measures what releasing each window's entries would free, and gives
  `app_delta` without them.

## Development Builds

A development build holds memory that production doesn't, so some figures
leave it out:

- **Production-only totals.** `memlab_explain_delta` and `memlab_ab_compare`
  report growth without memory held only through development roots and
  references: React Fast Refresh registries, React `_debug*` fields, DevTools
  globals, and the React Compiler's development hook guards. The raw figure is
  shown beside it. On a development build, one hash table that only exists
  there can double in size partway through a run, and the raw total then
  grows by megabytes with no change in the app.
- **Named patterns.** `memlab_dev_artifacts` tags the known development-build
  patterns it finds (`react-compiler-hook-guard`, `owner-stack-event-path`,
  `devtools-console` and `fast-refresh-registry`), each with its size and the
  tool that shows it in detail.

## Minified Builds

- **Minification renames variables, not record fields.** A probe that looks a
  collection up by its variable name finds nothing on a production bundle. A
  probe stuck at its own "not found" value at every rung is reported
  UNRESOLVED, not FLAT or FAIL. A `map-size` positive control can declare
  `value_keys`, the property names its values have, so it is still found by
  shape after the variable is renamed.
- **Module names survive.** `memlab_sparse_elements`, `memlab_cache_analysis`,
  `memlab_stale_collections` and `memlab_growth_signals` have a `Module`
  column: the module whose code holds each row's object. On a production
  build, this is often the only readable label.
- **Minified component names.** A production bundle names components `C` or
  `r`. `memlab_react_update_queues` adds the module that defines the
  component (for example `C [ChatListItem.react]`).

## How Results Are Shown

### Shorter Reports

- **Engine code is summed, not ranked.** `memlab_explain_delta` and
  `memlab_dev_subtracted_delta` put V8's own code (compiled code, bytecode,
  feedback and inline caches) on one line. It grows as new code paths are
  compiled and shrinks when unused code is flushed, so it would otherwise
  fill the top of the table with rows no app fix can change. Pass
  `include_engine: true` to list it.
- **Explanations are printed once per session.** A tool prints the note that
  explains its figures the first time in a session, and after that only says
  how many notes it left out. `repeat_notes: true` prints them again.
- **Long retainer paths are folded.** `memlab_retainer_trace` prints a
  repeating pattern (such as a scope chain alternating closures and Contexts)
  once, with its repeat count, and keeps only the first and last 20 steps of
  a path that is still longer. `expand: true` prints every step.

### Detached DOM

- **Compared by owner, not by id.** With a `baseline`,
  `memlab_detached_dom({group_by})` shows each group's count in the earlier
  snapshot and sorts by the change, so a large group that was already there
  reads as a standing population, not a new leak. Ids can change between
  captures, so owners are matched by class, and a scope by the names of the
  closures over it.
- **One row per kind of owner.** `memlab_detached_dom({group_by: "dominator"})`
  puts owners of the same class and module in one row, marked `×N`, instead of
  one row per object. It also gives the shortest retainer path of the top
  row's largest owner. When that row has 1,000 detached nodes or more, it lists
  every reference from the app into them (`memlab_island_doors`), because a
  fix that closes only the shortest path frees nothing while another holder
  remains. `island_doors: false` skips that step.

### Other Groupings

- **Rare path shapes.** After its `limit` of clusters, `memlab_trace_all`
  lists up to 15 more path shapes, one line each. New kinds of leaks often
  first appear as one of these small clusters.
- **Duplicated fields can be one duplicated object.** `memlab_duplicated_strings`
  also groups the largest duplicated values by the object shape that holds
  them. Three values duplicated about 1,400 times each, held as three fields
  of one shape, are reported as at least 1,400 copies of that object: the
  object is what to deduplicate.
- **`setState` calls that change nothing.** Over a ladder,
  `memlab_react_update_queues` names the setter behind each component's
  longest queue of pending updates (for example `setIsActive(false)`), and
  says whether every pending update sets the value already rendered.
  Components whose updates grow from such calls are listed separately: each
  is a call site to guard. Calling it again on the same rungs (as
  `memlab_analysis_battery` does) returns the earlier report instead of
  scanning again. For one snapshot, pass `snapshot` (a handle or a path) to
  read it without loading it first.
- **Source for a node.** `memlab_source_for_node` prints the function behind
  a closure from its module's span in the served bundle. On a minified line,
  it prints a window of characters instead of lines. For a Context, it also
  lists the variables and the closures over it, which is usually enough to
  tell which component's render scope it is.

### Write-Ups

`memlab_round_digest({run_dir, format: "doc_markdown", compare_to})` prints a
short Markdown section for a team document: the run, the audit verdict, the
heap after garbage collection, detached DOM nodes, leak candidates, a
comparison with the previous round, and TODO lines for your reading and the
next step.
