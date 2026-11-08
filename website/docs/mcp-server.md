# MCP Server for AI Assistants

The [`@memlab/mcp-server`](https://www.npmjs.com/package/@memlab/mcp-server)
package is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/)
server that wraps memlab's heap analysis APIs. It gives AI coding assistants
(Claude Code, Codex, Cursor, Windsurf, opencode, and any other MCP client) interactive tools to
load JavaScript heap snapshots, find memory leaks, and identify optimization
opportunities through natural language conversation.

Instead of clicking through the Chrome DevTools memory panel, you point the
assistant at a `.heapsnapshot` file and ask questions:

> Load `/tmp/my-app.heapsnapshot`, tell me what is growing, and show me the
> retainer trace for the biggest offender.

## Setup

### Claude Code and Codex plugin

The [memlab plugin](https://github.com/meta/memlab/tree/main/plugins/memlab)
installs this server together with
[Agent Skills](https://github.com/meta/memlab/tree/main/plugins/memlab/skills)
that teach the agent when and how to use it:

```bash
# Claude Code
claude plugin marketplace add meta/memlab
claude plugin install memlab@memlab

# Codex
codex plugin marketplace add meta/memlab
codex plugin add memlab@memlab
```

### Option 1: Global install

```bash
npm install -g @memlab/mcp-server
```

Then add the server to your MCP client config (`~/.claude.json` for Claude
Code, or `.mcp.json` for Cursor/Windsurf):

```json
{
  "mcpServers": {
    "memlab": {
      "type": "stdio",
      "command": "memlab-mcp",
      "env": {
        "NODE_OPTIONS": "--max-old-space-size=8192"
      }
    }
  }
}
```

### Option 2: npx (no install)

```json
{
  "mcpServers": {
    "memlab": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "-p", "@memlab/mcp-server", "memlab-mcp"],
      "env": {
        "NODE_OPTIONS": "--max-old-space-size=8192"
      }
    }
  }
}
```

### opencode

opencode reads MCP servers from `opencode.json` in its own format:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "memlab": {
      "type": "local",
      "command": ["npx", "-y", "-p", "@memlab/mcp-server", "memlab-mcp"],
      "environment": {
        "NODE_OPTIONS": "--max-old-space-size=8192"
      }
    }
  }
}
```

To use the memlab Agent Skills with it too, copy the directories under
[`plugins/memlab/skills/`](https://github.com/meta/memlab/tree/main/plugins/memlab/skills)
into `.opencode/skills/` in your project, or into `~/.config/opencode/skills/`.

### Option 3: From source

```bash
git clone https://github.com/meta/memlab.git
cd memlab
npm install
npm run build
```

```json
{
  "mcpServers": {
    "memlab": {
      "type": "stdio",
      "command": "node",
      "args": [
        "--max-old-space-size=8192",
        "/path/to/memlab/packages/mcp-server/dist/index.js"
      ]
    }
  }
}
```

:::caution Give Node.js enough heap

The server keeps the fully parsed graph resident: nodes, edges, dominator tree
and indexes. A full load needs several times the snapshot's on-disk size in
memory. Always start the server with `--max-old-space-size=8192` or higher; the
configurations above do this for you.

To avoid an out-of-memory crash, which would lose every loaded snapshot,
`memlab_load_snapshot` refuses a load in three cases:

- **File size:** the file is larger than `max_file_size_mb`. The default is
  900 MB or 0.25 × the old-space limit, whichever is larger: 2,048 MB on an
  8 GB server.
- **Node/edge count:** the snapshot's node or edge count is above the load
  ceiling. The ceiling is derived from the heap limit the server is actually
  running with: about 13.9M nodes and 55.7M edges at 8 GB.
- **Memory headroom:** the projected working set doesn't fit in the remaining
  heap, even after evicting the least-recently-used resident snapshot.

Raising `--max-old-space-size` raises all three limits, with no other change.
`force: true` attempts a one-off oversized load anyway.

Analysis can also fill the heap between loads. When the server's heap use
first passes 75%, 85% and 95% of its limit, the next tool result starts with a
one-line warning that gives the heap use, RSS and the number of resident
snapshots. Each level is announced once on the way up, so a session with room
to spare never sees it.

:::

## Command line (`memlab-cli`)

The package also installs `memlab-cli`, which runs the same tools without an
MCP client. Use it in a shell script or CI job, or when your assistant fails to
connect to the server.

```bash
memlab-cli doctor                      # check node, the server, and a live handshake
memlab-cli list                        # every tool with a one-line description
memlab-cli schema memlab_load_snapshot # a tool's input schema as JSON
memlab-cli call memlab_load_snapshot '{"file_path":"/tmp/a.heapsnapshot"}' \
                memlab_app_heap '{}'   # several calls in one server session
memlab-cli script steps.jsonl          # one {"tool":..,"args":{..}} per line
```

Loading a large snapshot takes minutes, so to keep snapshots loaded across
separate invocations, run one resident server with
`memlab-cli serve --socket /tmp/memlab.sock`. Then pass `--socket` to `call`,
`script` and `stop`.

`memlab-cli` starts the server with its own `--max-old-space-size`, which
overrides `NODE_OPTIONS`. Set `MEMLAB_MAX_OLD_SPACE_MB` to change it. By
default it uses 60% of physical RAM (at least 8 GB), or 60% of the container's
memory limit.

## Getting a heap snapshot

Both `.heapsnapshot` files and `.heaptimeline` files (snapshots recorded with
allocation tracking on) load. `memlab_allocation_sites` groups live objects by
the stack that allocated them in such a capture.

### From Chrome DevTools

1. Open DevTools (F12) and go to the **Memory** tab.
2. Select **Heap snapshot** and click **Take snapshot**.
3. Right-click the snapshot in the left panel and choose **Save...**.
4. Save the `.heapsnapshot` file somewhere the MCP server can read it.

### From a live page and its workers

Start Chrome with `--remote-debugging-port=9222 --user-data-dir=<temp dir>` (Chrome 136 and
later ignore the port flag on the default profile) and ask the assistant to run
`memlab_capture` with an output directory. It snapshots the page and its
dedicated workers, which a page snapshot never contains. Compare the page and
workers with `memlab_realm_summary`. `list_targets: true` lists the pages to
choose from. Give each capture a `label` and refer to it later as
`checkpoint:<label>` anywhere a snapshot path is accepted, for example
`memlab_diff_snapshots({before: "checkpoint:baseline", after: "checkpoint:after"})`.

To check a hypothesis against the running app, `memlab_live_eval` evaluates
one expression in the same page and returns its JSON value, for example
`Object.keys(window.Debug ?? {})`. It refuses anything V8 cannot prove
side-effect free unless `allow_side_effects` is set, and gives up after
`timeout_s` seconds.

### From Node.js

```js
const v8 = require('v8');
const snapshot = v8.writeHeapSnapshot();
console.log(`Heap snapshot written to ${snapshot}`);
```

### From memlab

Snapshots taken by [`memlab run`](./cli/CLI-commands.md) are saved under the
working directory printed at the end of the run (see
`memlab get-default-work-dir`), and can be loaded directly.

## A typical investigation

A memory investigation with the MCP server usually follows this shape — all of
it in conversation, with the assistant picking the tools:

1. **Load the snapshot** — "Load the heap snapshot at
   `/tmp/my-app.heapsnapshot`."
2. **Frame the heap** — "What is this heap made of?" The assistant splits the
   heap into application data, bundle source and V8 internals
   (`memlab_app_heap`). Then it looks at a class histogram and the biggest
   retainers.
3. **Find what is growing** — with a series of snapshots taken while an
   interaction repeats: "Which classes grow on every snapshot?"
4. **Leak or working set?** — "Does this growth plateau, and is it given back
   after idle and GC?" Steady growth across a short series can still be a
   bounded cache or work in flight.
5. **Rule out noise** — "Is any of this retained only by DevTools or browser
   extensions?"
6. **Explain the retention** — "Show me the retainer trace for node 48231, and
   tell me which reference to break." For three common families (a no-op
   `setState` that leaves update records, a listener added per mount, a
   stale value in a React Compiler memo cache), the tool that finds it points
   to `memlab_fix_knowledge_check({action: "pattern", family})`, which gives
   the fix that has worked and the test that catches its usual mistake.
7. **Confirm the fix** — capture a new set of snapshots after the fix and ask
   whether the per-cycle growth rate went down (`memlab_verify_fix`).

## What the tools can answer

The server ships about 150 tools, organized by the question they answer:

| Question | Representative tools |
| --- | --- |
| What is this heap made of? | `memlab_app_heap`, `memlab_memory_partition`, `memlab_native_contexts`, `memlab_quick_diagnosis`, `memlab_class_histogram`, `memlab_largest_objects`, `memlab_shape_histogram`, `memlab_what_if` |
| Is anything growing — and is it a leak? | `memlab_leak_report`, `memlab_shape_census_diff`, `memlab_growth_cohort` (the newest instances of a class by holder and shape, against a baseline rung), `memlab_collection_diff`, `memlab_ladder_probe`, `memlab_rate_model`, `memlab_settle_check`, `memlab_verify_fix`, `memlab_element_census` (React elements and fibers per component, by what holds them) |
| Who owns the growth / why is X retained? | `memlab_retainer_trace`, `memlab_retainer_summary`, `memlab_trace_all`, `memlab_react_owners`, `memlab_dominator_chain`, `memlab_pinch_points`, `memlab_explain_delta`, `memlab_dead_context_variables`, `memlab_scope_chains`, `memlab_retained_by`, `memlab_allocation_sites`, `memlab_error_callsites` (where retained Errors were created, from their captured frames) |
| Is it real, or a measurement artifact? | `memlab_artifact_budget`, `memlab_dev_artifacts`, `memlab_replicate`, `memlab_check_health`, `memlab_module_source` (the module's served source, dev compile vs prod compile) |
| Detached DOM and event listeners | `memlab_detached_dom`, `memlab_dom_audit`, `memlab_event_listener_leaks`, `memlab_event_registry` (`group_by` emitter, context class and callback: whose listener records these are) |
| Collections and caches | `memlab_cache_analysis`, `memlab_stale_collections`, `memlab_map_entries`, `memlab_weakref_census`, `memlab_property_distribution`, `memlab_model_duplicates` (records that share an id: copies of a one-per-id model) |
| Strings and duplication | `memlab_intern_opportunities`, `memlab_duplicated_strings`, `memlab_string_patterns`, `memlab_sliced_strings`, `memlab_duplicate_objects` |
| Inspect or find specific objects | `memlab_query_objects`, `memlab_get_node`, `memlab_object_shape`, `memlab_get_references`, `memlab_get_referrers`, `memlab_find_nodes_by_class`, `memlab_find_by_shape`, `memlab_closure_inspection` |
| None of the above | `memlab_eval`, `memlab_eval_across`, `memlab_auto_investigate` |
| Sharing a capture | `memlab_anonymize_snapshot` |
| Session, batching and write-ups | `memlab_load_snapshot`, `memlab_snapshots`, `memlab_batch`, `memlab_finding_index`, `memlab_analyze_run` |

Every byte-size filter takes bytes or a size such as `"1MB"` or `"500KiB"`
(KB = 1000 bytes, KiB = 1024).

Ranked lists page the same way: `offset` skips rows, and every page ends with
"Showing a–b of N … Next page: `offset: k`". Ties are broken by node id, so a
given offset always shows the same rows. `memlab_snapshots` with
`max_name_length` clips node names in every tool for the rest of the session,
including the `name` in `memlab_eval` helper results, and
`table_format: "csv"` renders tables as compact CSV. With `terse: true`,
`memlab_retainer_trace` also leaves out sizes unless `show_sizes` is passed.
The main list and lookup tools also return `structuredContent`: the same rows
as JSON, with node ids scoped by a `snapshot` handle, raw byte counts, the
filters that applied and a `pagination` object.

To keep the tool list short, start the server with
`MEMLAB_TOOLSETS=core` (or `core,growth,retention`, …): only those groups are
exposed, and `memlab_tools({enable: "<group>"})` turns more on mid-session.

Ask the assistant to call **`memlab_tools`** to print the full index, grouped
the same way, with a one-line "use it when" for every tool. It is the fastest
way to discover a tool you didn't know to ask for. `memlab_tools` with a `tool`
and `schema: true` prints that tool's parameters.

### Captured variables no live code can read

All closures created in one scope share one V8 Context. A large value read
only by a callback that has already run stays alive for as long as any
sibling closure does. Snapshots from V8 15.6 (Chrome 156) and later include
the source scope tree of every script. `memlab_dead_context_variables` checks
each Context slot against the closures and suspended async functions still on
the heap. It reports the variables nothing live can read, ranked by the bytes
they retain. Each row gives the Context and value ids, ready for
`memlab_retainer_trace`. For the most accurate results capture with Chrome 157
or later, which leaves out script-level `let`/`const`. Older snapshots have no
scope tree, and the tool says so.

### Scope chains

A function that captures a closure from its previous call pins that call's
whole Context, and so on back to the first call. Every link is a
`system / Context`, so a chain that grows by one per interaction never shows
up in a class count. `memlab_scope_chains` follows context → captured closure
→ that closure's Context, keeping only links between Contexts of the same
function. For each function it reports the longest chain, the linking
variables and the head's id. With `run_dir` or `paths` it gives the longest
chain at every rung, so you can tell a chain that keeps growing from one
that stops.

To size a fix, `memlab_what_if({scope_of: <head id>})` frees every Context of
that function's scope at once, every chain and not just the longest, and
reports the dominator-deduped bytes that come back (`cascade: true` adds what
they were the last holder of). A closure id or a `system / ScopeInfo` id
works as well.

The React Compiler's development build makes chains on its own. It wraps each
hook call in a guard closure that captures the hook's arguments, so the
compiler temporaries `t0`…`tN` end up in Contexts and cached effect closures
link each render to the previous one. A chain linked only through those
temporaries is labelled as this artifact. A production compile calls the hook
directly and does not create it: read the module from a production capture
with `memlab_module_source` and `compare_to` to confirm.

### Served source

A snapshot keeps the source text of every script it loaded, so the code that
actually ran can be read back next to the objects it created.
`memlab_module_source` prints a module's source, or the lines matching `grep`.
Inside `memlab_eval`, `helpers.moduleSource(name)` returns the same spans, so a
query can print the declaration behind a finding; `mode: "recipes"` has a worked
example. `helpers.scripts()` lists every script with its source string and
`helpers.stringsBySize({minLen})` the longest strings, so a search over source
text reads a hundred scripts instead of every string node.

### Custom queries

In `memlab_eval`, code may assign its answer to `result` or `return` it at the
top level. A node's `references` and `referrers` take array methods
(`.filter`, `.map`, `.find`, `.length`, …) as well as `for…of`, and
`node.props` maps an object's property names, or a context's variable names,
to nodes.
`helpers.ctxVars(closureOrContext)` lists a scope's variables,
`helpers.arrayLen(node)` counts a collection's entries rather than its table
slots, and `helpers.firstRetainer(node)` names the holder one hop up. For
React, `helpers.fiberOf(domNode)` returns a mounted element's fiber,
`helpers.componentName(fiber)` its component, `helpers.hooks(fiber)` its hook
list with pending updates, and `helpers.memoCacheSlots(fiber)` the React
Compiler cache slots (`updateQueue.memoCache.data[block][slot]`) that can keep
a stale closure or element alive. Asking
for a helper that does not exist suggests the one that does the job, such as
`histogram` for `groupBy`.
Before any code runs, a lint refuses three mistakes that would otherwise cost
a whole scan: a helper name that does not exist, code with no output (no
`result`, `return`, `console` or `helpers.save`), and an
`e.type === 'context'` filter in code that never reaches a scope object (a
closure's hop to its scope is an `internal` edge named `context`). Pass
`skip_lint: true` when the match is wrong.
`memlab_eval_across({run_dir, code, format: "table"})` runs one query on every
rung; when each returns a number or a flat object of scalars, the answer is
one key × rung table with a first-to-last Δ.

### Saved probes

A hunt on one app measures the same few populations every round. Save each
once with `memlab_probes`: `memlab_eval` code that assigns a number to
`result`, plus an optional `expect` (`flat` or `bounded`) and `cap`. Probes
live in named sets in `~/.memlab/probes.json`. Give a set a `match`, a
substring of the round's URL filter, and `memlab_ladder_probe`,
`memlab_ab_compare` and `memlab_analysis_battery` run it without being asked,
printing OK or VIOLATED for every probe that has an `expect`. Any of them also
takes `probes: "<set>"`.

```js
memlab_probes({mode: 'save', set: 'myapp', match: 'myapp.example.com',
  name: 'open_dialogs', code: "result = helpers.byClass('Dialog').length",
  expect: 'flat'})
```

### Findings index

`memlab_finding_index` keeps the findings of earlier rounds so a new round can
`check` a candidate before investigating it. A finding is keyed by its
normalized retainer path. Some populations have no stable path, so pass a
`kind` and its `keys` instead:

| `kind` | Keys |
|---|---|
| `update-queue` | `component`, and `hook_ordinal` or `setter` |
| `collection` | `class` (optionally `probe`) |
| `probe` | `probe` (optionally `set`) |
| `optimization` | `owner` and `waste_kind` (optionally `module`): memory a fix gives back at a steady size, not a leak |

```js
memlab_finding_index({action: 'record', kind: 'update-queue', round: 'r12',
  keys: {component: 'ChatList', hook_ordinal: 3, setter: 'setMenuOpen'}})
```

`list` takes `round`, `since_round` (last seen in that round or later),
`status`, `title` (matches title, signature and note) and `kind` as filters.
`verified_by_ab` takes `true` or the A/B itself, `{round, metric, off, on}`,
which `record` and `check` then print next to the fix. `cover` records the combos a round drove; with `run_dir` it also
reads the served revision and a hash of the gating values from run.json, so
two rounds that drove the same combos against different code or gating can
be told apart.

Pass `run_dir` to any action and the round fills in `round` and, when no
`workstream` is given, the workstream: run.json `findings_workstream`, or an
existing index named after run.json `app`. A `check` that finds nothing under
the exact fingerprint lists entries that are probably the same finding (the
same path with another class set, or a path whose last hops share names);
attach the sighting to one with `action: "reconfirm"`, `fingerprint` and an
optional `rate`. Set `MEMLAB_FIX_STATUS_CMD` to a shell command containing
`{diff}` to show the live status of each diff a finding records as its fix.

## Reading the numbers

memlab and the browser's own heap profiler read the same snapshot, but a few
figures are defined or grouped differently:

- **Self size** is the profiler's *shallow size*. **Retained size** of a node
  has the same dominator-tree definition in both.
- **Class retained size** (`memlab_class_histogram` with
  `include_retained_size`) counts each byte once even when instances hold one
  another, like the profiler's constructor rows. Rows overlap across classes,
  so neither adds up down the table.
- **Class keys** are `type::name` in memlab (`closure::onClick`,
  `object::Map`). The profiler groups by constructor name, with `(closure)`,
  `(string)`, `(array)` and `(system)` groups.
- **Total** is the root's retained size plus `extra_native_bytes` in both.
- **Distance** and **detachedness** (`memlab_get_node`) match the profiler's:
  hops from the root with page globals at 1, and attached / detached /
  unknown.
- **Default lists** in memlab leave out engine-internal node types (arrays,
  code, native, synthetic) unless you ask for them by `node_type`.
- **Engine code in deltas is summed, not ranked.** `memlab_explain_delta` and
  `memlab_dev_subtracted_delta` put V8 engine code (compiled code, bytecode,
  feedback, inline caches, and what code flushing drops) in one line of its
  own. It grows as new paths are compiled and shrinks when cold code is
  flushed, so it otherwise filled the top of the table with rows no app fix
  can change. Pass `include_engine: true` to list it.
- **Production-only totals** leave out memory a development build holds only
  through a dev root or dev edge (React Fast Refresh registries, React
  `_debug*` fields, devtools globals, and the React Compiler's dev hook-guard
  links: a compiler temporary `tN` holding a closure into an earlier context
  of the same scope). `memlab_explain_delta` and
  `memlab_ab_compare` report growth this way by default, with the raw figure
  beside it. On a dev build a single dev-only hash table can double in size
  partway through a run, and the raw total then grows by megabytes with no
  change in the app.
- **Explanations are printed once per session.** A tool keeps the figures of
  a result apart from the italic note that explains them, prints the note the
  first time in a session, and after that only says how many notes it left
  out (`repeat_notes: true` prints them again). `memlab_leak_report`'s settle
  and idle-floor lines, for example, carry only their counts.
- **Bounded windows are reported apart from `app_delta`.** A collection the
  app empties on a timer (a 30-minute trace buffer, a TTL cache) fills for as
  long as the window lasts, so on a shorter ladder it reads as linear app
  growth. `memlab_artifact_budget({windows: [{name, edge, value_keys}]})`
  measures what releasing each window's entries would free (counting every
  holder, such as a cleanup timer per entry) and also states `app_delta`
  without it. The battery passes the round's `map-size` positive controls.
- **Source for a node comes from the snapshot.** Browser captures keep each
  script's source text, so `memlab_source_for_node({node_ids, context_lines})`
  prints the function behind a closure, or behind a context (through a closure
  over it), from its module's span in the served bundle. A minified line gets a
  character window instead of lines. A context also lists its variables and the
  closures over it, which is usually enough to say which component's render
  scope it is.
- **Detached DOM is compared by owner, not node id.** With `baseline`,
  `memlab_detached_dom({group_by})` shows each group's count at the earlier
  snapshot and sorts by the change, so a large group that was already there
  at the first rung reads as a standing population, not the round's leak.
  Node ids can change between captures, so owners are matched by class, and a
  scope context by the names of the closures over it.
- **One row per kind of owner.** `memlab_detached_dom({group_by: "dominator"})`
  puts owners of the same class (a scope by its closures) and module in one
  row, marked `×N` with the number of owner objects, instead of one row per
  object. A component that leaks once per mount had printed the same scope 19
  times. The output also gives the shortest retainer path of the top row's
  largest owner, folded in the middle. When that row has 1,000 detached nodes
  or more, it also lists every application-side reference into the island
  (`memlab_island_doors`), since a fix that closes only the shortest path
  reclaims nothing while another holder remains. `island_doors: false` skips
  that heap walk.
- **Rare path shapes.** Past its `limit` rendered clusters,
  `memlab_trace_all` lists up to 15 more path shapes, one line each, with
  their object count and the last four hops. New leak classes often first
  appear as one of these small clusters.
- **Long retainer paths are folded.** `memlab_retainer_trace` prints a
  repeating multi-hop pattern (a scope chain alternating closures and
  contexts) once, with its repeat count, on the first hop outside the
  pattern, and keeps the first and last 20 steps of a path that is still
  longer than that. `expand: true` prints every hop.
- **Warm-up is not a leak.** A class that grows at every rung while each step
  adds less than the one before (preloading, first-open loads) reads
  `SATURATING` in `memlab_leak_report` once its last step adds under 20% of
  what its first did. It is not counted as a leak candidate. A mount followed
  by steady growth reads `STEP+LINEAR`, with its post-step rate, which is the
  leak rate; the overall Δ/cycle overstates it. A class with at least 80% of
  its growth in one step, wherever that step is, and less than
  `min_growth_count` over the other steps reads `ONE-TIME` and is not a
  candidate either. `memlab_settle_check` says "grew further at rest" only
  when the class gained more than 10% of its growth (and more than two
  instances) between the busy rung and the settle rung.
- **Rows that grow together are one leak.** `memlab_leak_report` groups
  growing rows whose change is the same, or a whole multiple of it, at every
  step. A leaked subtree shows up as a detached element, the listener holding
  it and the scope holding the listener, each growing once per cycle; the group
  says to trace one of them. The base row must grow on at least two steps, so
  classes that only jumped once at first mount are not grouped.
- **A round write-up is a tool call.**
  `memlab_round_digest({run_dir, format: "doc_markdown", compare_to})` prints
  a short Markdown section for a team document: the run, the audit verdict,
  post-GC heap (per arm on an A/B round) and `app_delta`, leak candidates and
  the settle split from the battery output, a "vs <previous round>" line, and
  TODO lines for the reading and the next step.
- **A whole-number rate is a mechanism.** `memlab_compare_rounds` lists
  every population, in any round of a sweep, whose rate is a whole number per
  cycle or per landed step (from run.json `steps`), with the step it matches.
  A combo that opens two chats per cycle reads 2.000/cycle for one record per
  chat open; the table says `1 per open-chat`.
- **Duplicated fields can be one duplicated object.** Besides the per-value
  table, `memlab_duplicated_strings` regroups the largest duplicated values by
  the object shape that holds them. Three values duplicated about 1,400 times
  each, held as three fields of one request-parameters shape, are reported as
  at least 1,400 copies of that object, which is the thing to deduplicate.
- **Collection tables name the owning module.** `memlab_sparse_elements`,
  `memlab_cache_analysis`, `memlab_stale_collections` and
  `memlab_growth_signals` have a `Module` column: the module whose code holds
  the row's object, read from the module scope its closures share. Module names
  survive minification, so on a production build this is often the only
  readable label. `memlab_sparse_elements` also splits stores that have no
  named owner by module, instead of pooling them as one "(unattributed)" row.
- **Minified builds rename variables, not record fields.** A probe that
  looks a collection up by its variable name finds nothing on a production
  bundle. A probe stuck at -1 (its own "not found" value) at every rung, and a
  positive control whose edge is missing on a minified heap, are reported
  UNRESOLVED, not FLAT or FAIL. A `map-size` positive control can declare
  `value_keys`, the property names its values carry, so it is still found by
  shape when the variable is renamed.
- **Minified component names.** A production bundle names components `C`
  or `r`. `memlab_react_update_queues` adds the module that defines the
  render function (`C [ChatListItem.react]`), read from the module
  registry, and takes a queue's fiber from its setter's bound arguments, so
  a mounted component is not reported as "(no fiber)".
- **No-op `setState` calls.** Over a ladder, `memlab_react_update_queues`
  names the setter of each component's longest queue on the last rung
  (`setIsActive(false)`, with the hook's position and the module whose scope
  holds the setter) and whether every pending record is the value already
  rendered. Components whose records grow linearly from such no-op calls are
  listed separately: each is a call site to guard. Repeating a ladder call on
  unchanged rungs, such as the one `memlab_analysis_battery` makes, returns
  the earlier report instead of rescanning. For one snapshot, pass
  `snapshot` (a handle or a path) to read it without loading it first.
- **Named dev-build patterns.** `memlab_dev_artifacts` tags the known
  development-build patterns it finds: `react-compiler-hook-guard`,
  `owner-stack-event-path`, `devtools-console` and `fast-refresh-registry`.
  Each tag comes with its size and the tool that shows it in detail, so a
  round can name a pattern instead of tracing it again.

## Working with more than one snapshot

A tool that compares two snapshots by `baseline` and `target` also takes a
round's `run_dir` (and `rungs: [i, j]`, default the first and last rung), and
`path` / `snapshots` are read as `file_path` / `paths` (and `snapshot_path` as
`snapshot`, `id` as `node_id`, among a few others). Each load gets a handle,
by default its file name; when that name is already resident, say two rounds
that both have a `rung_00_c0`, the reply names the holder and gives the new one
`rung_00_c0#2`, so pass `alias` to tell them apart.

Every single-snapshot tool takes an optional `snapshot`: a resident handle, or
a `.heapsnapshot` path that is loaded for that call only. The active snapshot
does not move, so you can ask about two captures side by side without
switching between calls. Ladder tools and `memlab_eval_across` borrow their
rungs the same way: a borrowed snapshot is active only inside the call that
borrowed it, so a background job and another call running at the same time
each read their own snapshot, and the session's active snapshot stays put.

Leak detection needs a trend, not a single capture. Pass `keep_previous: true`
when loading so earlier snapshots stay resident: each one gets a *handle*, and
`memlab_snapshots` lists them, switches the active one, or unloads the ones you
are done with. V8 keeps an object's id for its whole lifetime, so ids match
across captures of the same isolate (one tab session, no reload) and nowhere
else. `memlab_diff_snapshots` detects that case and matches objects by id,
listing the objects allocated between two captures that are still alive; for
captures of different isolates, switch to the right handle before reusing an
id.

Ids never carry across isolates, but a *stable key* does: `helpers.stableKey`
in `memlab_eval` names a collection by its path from a module scope
(`Store.pendingById`), which is the same in every capture. Save a
`{stableKey → entries}` map with `helpers.save` on one snapshot, read it back
on the next with `helpers.load(name, {allowCrossSnapshot: true})`, and diff;
`memlab_eval({mode: "recipes"})` has the full example.

Within one isolate, a heap object's id also tells you when V8 first saw it:
heap objects get odd ids in increasing order, while native and synthetic nodes
get even ids derived from an address or hash. In `memlab_eval`,
`helpers.newest(ids, n)` and `helpers.ageRank(id)` order objects by that id, and
`helpers.maxObjectId()` saved on one rung splits a population on the next into
objects that already existed and objects allocated since.

Every resident snapshot holds its full graph in memory. Watch the server's
footprint with `memlab_server_status` and unload snapshots you no longer need.

:::tip Peek before you load

`memlab_snapshot_header` reads a snapshot's header — node/edge counts, capture
time, file size, native memory with no node (`extra_native_bytes`) — *without*
parsing it, and tells you whether it fits under the
current load ceiling. Use it to pick a loadable capture in one step instead of
attempting an oversized load.

:::

### Snapshot ladders

The growth tools work on a *ladder*: an ordered series of snapshots captured
while one interaction repeats. Most of them load each rung transiently and
release it, so a long ladder doesn't have to fit in memory at once.
`memlab_analysis_battery` runs several of them over the same rungs, so it
keeps rungs parsed between its steps while memory allows
(`MEMLAB_RETAIN_RUNGS` caps how many). After each step it rewrites
`battery.partial.json` with the digest rows of the steps done so far, so the
first results can be read while a slow step still runs, and it writes
`battery.done.json` to its output directory last, so a script can wait on that
one file;
`memlab_battery_status({battery_id, wait_ms})` waits for it from the assistant
side, and `wait_for_rungs: "all"` queues a battery until the round's
`round.done` marker appears. On an A/B round (run.json has an `ab` section
and the ladder splits between the arms), the battery runs each ladder step
once per arm, writes `<tool>.off.txt` and `<tool>.on.txt`, and adds one
`memlab_ab_compare` verdict table. That table always has a row for React
state-update records (the `react_update_records` census population), the
population a no-op `setState` fix removes. Every profile also runs
`memlab_blink_native_census`, which counts native (Blink) objects per rung and
rates a fixed list of uncapped browser holders (ordered scopes, performance
entries, User Timing marks, event-target data, style caches, observer
registrations) by name, so native growth that no JavaScript-side step sees is
in the digest; it is left out on A/B rounds. When the round recorded
`performance.measureUserAgentSpecificMemory()` per rung (the page must be
cross-origin isolated), the header gives its first and last value per segment,
with the dedicated-worker share: workers and wasm are in no page snapshot, so
this is the only place their growth shows. `memlab_hunt_report` lists the same
two numbers per rung in its off-heap table. Once per sweep (the round
directories sharing a parent), a `standard` battery also runs
`memlab_sparse_elements`, `memlab_duplicated_strings` and
`memlab_duplicate_objects` on the final rung and puts their top rows in the
digest: on the first round, and again when a round's final rung is at least
25% larger than the largest one already scanned. The digest ends with the next calls worth
making for that round; a call already suggested in an earlier round of the
same sweep, for the same class, is named once instead of repeated. Likewise a
`memlab_round_audit` row an earlier round of the sweep showed word for word is
folded into one "N check(s) unchanged since …" line; the verdict always shows.
`memlab_round_audit` also names each recorded fix (`memlab_finding_index`)
whose `fixed_behind` prop the build does not serve: absent from the registry,
or defined but read by no served code. That round runs without the fix, so its
finding can reappear without a regression. You can
give a ladder in three ways:

- **`paths`:** an ordered list of snapshot files. Cycle counts are read from
  `rung_NN_cNNN.heapsnapshot` filenames; otherwise rungs are assumed evenly
  spaced, and the report says so.
- **`run_dir`:** a directory whose `run.json` lists the rungs, the cycles
  driven at each rung, and an optional *settle* rung captured after idle and
  GC. The settle rung is what tells a leak apart from work still in flight.
- **`ladder:<name>`:** a name registered once with `memlab_ladder`.

`memlab_eval_across` takes `paths`, or `run_dir` with `rungs: [0, -1]`, to run
one eval program over chosen rungs the same way, without loading them first.
Each rung gets a timeout scaled from its size, as `memlab_eval` does, unless
`timeout_ms` is given.

The first load of a rung writes a sidecar index next to it
(`<snapshot>.memlab-index.json`) with class counts, edge names and shape
tables. Later ladder calls read the sidecar instead of parsing the rung:
`memlab_shape_census_diff` with no filter or with `class_filter: "Object"`
takes seconds over a ladder that already has one.

`memlab_build_pair_compare({dev_run_dir, prod_run_dir})` lines up a round
driven on a development build with one driven on a production build. Record
fields survive minification, so populations are matched by property set, and by
class where the name is not mangled. Each row is dev-only, production-real,
production-saturating or production-only, and the summary says how much of the
dev build's per-cycle growth the production build keeps. A row is
production-saturating when it grows on dev but the production round's second
half, from its middle rung, grew under 20% as fast as its first: the growth is
bounded on production.

Ladder tools can run longer than an assistant's tool timeout. Start them with
`memlab_start_job` and collect the result with `memlab_job_status`. A large
snapshot can be loaded the same way with `memlab_load_snapshot({async: true})`,
and `memlab_eval_across` takes `async: true` too. `memlab_job_status` and
`memlab_battery_status` take `wait_ms`, capped at 90 s so the call returns
before a client that backgrounds long calls (at 120 s) would. A RUNNING reply
carries the time it was written, so a reply delivered late reads as stale. Every call
also runs under a wall-clock budget (90 s by default; override it with
`timeout_ms` or `MEMLAB_ANALYSIS_TIMEOUT_MS`), so a runaway scan returns a clean
"analysis stopped" result instead of wedging the server.

## Tool permissions and safety

No tool ever modifies the heap snapshot it analyzes, and most tools are
read-only analysis. Two groups are exceptions. Start the server with
`MEMLAB_DISABLE_CODE_TOOLS=1` to turn off the tools that run JavaScript
altogether. Every tool declares MCP
annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint` and a `title`), so a client that honours them can auto-approve
the read-only tools and keep asking for these.

:::danger Do not auto-approve tools that execute JavaScript

These tools run JavaScript passed in by the assistant, or read from a round
directory's files, with the full privileges of the MCP server process:

- `memlab_eval` and `memlab_eval_across`
- `memlab_live_eval`, which runs its code in your live page, with the page's
  session, rather than in the server
- `memlab_for_each`
- `memlab_hypothesis`
- `memlab_ladder_probe` and `memlab_replicate`
- `memlab_judges`, `memlab_calibrate_judges` and `memlab_switch_matrix`
- `memlab_ab_compare`
- `memlab_analysis_battery`, when the round holds an `invariants.json`

`memlab_batch` and `memlab_start_job` can call any of them.

They use `node:vm` to scope the globals they inject, but
[`node:vm` is not a security sandbox](https://nodejs.org/api/vm.html). Code
can reach the host realm and from there the filesystem, network and shell.
Heap snapshot contents are attacker-influenceable input, so a prompt injection
could steer the model into running hostile code. Keep these tools on manual
approval, and avoid a `mcp__memlab__*` wildcard allowlist, which would
auto-approve them too.

:::

A second group has side effects outside the heap. `memlab_capture` connects to
a running Chrome and writes snapshots. `memlab_prune_run` compresses or deletes
a round's snapshot files; its default mode is a dry run. `memlab_anonymize_snapshot`
and `memlab_analysis_battery` write files. `memlab_finding_index`, `memlab_metric`
and `memlab_ladder` keep small state files under your home directory.

To stop your assistant prompting on every call while keeping these on manual
approval, allowlist the read-only tools you use explicitly. For Claude Code,
put the list in `~/.claude/settings.json` (user-level) or `.claude/settings.json`
(project-level):

```json
{
  "permissions": {
    "allow": [
      "mcp__memlab__memlab_tools",
      "mcp__memlab__memlab_load_snapshot",
      "mcp__memlab__memlab_snapshot_header",
      "mcp__memlab__memlab_snapshots",
      "mcp__memlab__memlab_app_heap",
      "mcp__memlab__memlab_snapshot_summary",
      "mcp__memlab__memlab_class_histogram",
      "mcp__memlab__memlab_retainer_trace"
    ]
  }
}
```

## Further reading

- [MCP server README](https://github.com/meta/memlab/blob/main/packages/mcp-server/README.md)
  — the full tool reference (every tool, grouped by the question it answers),
  plus the `memlab-cli` commands, the state files the server writes, and all
  `MEMLAB_*` environment variables.
- [MCP investigation skill](https://github.com/meta/memlab/blob/main/packages/mcp-server/MCP_SKILL.md)
  — a structured methodology for assistants: step-by-step triage, guided
  investigation paths for string waste, DOM leaks, object accumulation, closure
  leaks and listener accumulation, plus token-efficiency tips.
- [AI assistant guide](https://github.com/meta/memlab/blob/main/AI.md) —
  guidance for AI assistants using memlab more broadly, including writing test
  scenarios and reading retainer traces.
