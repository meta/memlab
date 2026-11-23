---
title: Advanced Analysis
---

These features go beyond the everyday tools. Most investigations don't need
them, but they answer questions no class count or retainer trace can.

## Closures and Scopes

### Variables No Live Code Can Read

All closures created in one scope share one V8 *Context*. A large value used
only by a callback that has already run stays alive for as long as any other
closure from the same scope does.

`memlab_dead_context_variables` finds these values. It checks each variable
in each Context against the closures and suspended async functions still on
the heap, and reports the variables that nothing live can read. Rows are grouped
by scope (function and source position) and ranked by the bytes clearing them
would free: a value counts only when its Context is its immediate dominator.
A dead variable pointing at something live code also reaches, such as the
page's `Window` or `Document`, frees nothing, so it is left out unless you
pass `include_shared: true`. Each row gives the ids to pass to
`memlab_retainer_trace`.

This needs the source scope tree that V8 15.6 (Chrome 156) and later include
in snapshots. For the most accurate results, capture with Chrome 157 or later,
which leaves out script-level `let` and `const`. On older snapshots, the tool
says the scope tree is missing.

### Scope Chains

A function that captures a closure from its previous call keeps that call's
whole Context alive, and that one keeps the call before it, back to the first
call. Every link is a `system / Context`, so a chain that grows by one per
interaction never shows up in a class count.

`memlab_scope_chains` follows these links between Contexts of the same
function. For each function, it reports the longest chain, the variables that
link it, and the id of its head. With a ladder (`run_dir` or `paths`), it
gives the longest chain at every rung, so you can tell a chain that keeps
growing from one that stops.

To size a fix, `memlab_what_if({scope_of: <head id>})` frees every Context of
that function's scope at once, and reports how many bytes would come back,
without counting any byte twice. `cascade: true` adds what those Contexts
were the last holder of.

:::note React Compiler development builds

The React Compiler's development build creates scope chains of its own: it
wraps each hook call in a closure that captures the hook's arguments. A chain
linked only through the compiler's temporaries (`t0` … `tN`) is labelled as
this artifact. A production build doesn't create it; to confirm, read the
module from a production capture with `memlab_module_source` and
`compare_to`.

:::

## Served Source

A browser snapshot keeps the source text of every script the page loaded, so
you can read the code that actually ran next to the objects it created.

- `memlab_module_source` prints a module's source, or the lines that match
  `grep`.
- `memlab_source_for_node({node_ids, context_lines})` prints the function
  behind a closure, or behind a Context through a closure over it.
- In `memlab_eval`, `helpers.moduleSource(name)` returns the same source,
  `helpers.scripts()` lists every script with its source text, and
  `helpers.stringsBySize({minLen})` the longest strings, so a search over
  source text reads a hundred scripts instead of every string.

## Custom Queries

When no tool answers your question, `memlab_eval` runs a JavaScript program
against the snapshot. The program assigns its answer to `result`, or returns
it.

- A node's `references` and `referrers` work like arrays (`.filter`, `.map`,
  `.find`, `.length`, `for…of`).
- `node.props` maps an object's property names, or a Context's variable names,
  to nodes.
- Helpers do common work: `helpers.ctxVars(node)` lists a scope's variables,
  `helpers.arrayLen(node)` counts a collection's entries, and
  `helpers.firstRetainer(node)` names the object one hop up.
- For React: `helpers.fiberOf(domNode)` returns a mounted element's fiber,
  `helpers.componentName(fiber)` its component, `helpers.hooks(fiber)` its
  hooks with their pending updates, and `helpers.memoCacheSlots(fiber)` the
  React Compiler cache slots that can keep a stale closure alive.
- `helpers.groupByShape(ids)`, `helpers.topRetainers(ids)` (who outside a set
  holds it), `helpers.referrerChains(id)` and `helpers.edgeWalk(id, names)`
  replace the walks people otherwise write by hand.
- To ask several things at once, pass `queries: [{name, code}, ...]` instead
  of `code`. The answers come back keyed by name, and one query failing does
  not stop the others.
- `memlab_eval({mode: "recipes"})` prints worked examples.

Before running a program, the tool checks it for mistakes that would waste a
whole scan: a helper that doesn't exist (it suggests the right one), a
program with no output (no `result`, `return`, `console` or `helpers.save`),
and an `e.type === 'context'` filter in code that never reaches a scope (a
closure's link to its scope is an `internal` reference named `context`). Pass
`skip_lint: true` if the check is wrong.

To run one program on every rung of a ladder, use `memlab_eval_across` (see
[Snapshot Ladders](./snapshot-ladders.md#run-one-query-on-every-rung)).

:::caution

`memlab_eval` runs code with the privileges of the server process. See
[Tool Permissions and Safety](./safety.md) before approving it.

:::

## Saved Probes

If you investigate the same app again and again, you measure the same few
populations each time. Save each one once with `memlab_probes`: a
`memlab_eval` program that assigns a number to `result`, optionally with an
`expect` (`flat` or `bounded`) and a `cap`.

```js
memlab_probes({mode: 'save', set: 'myapp', match: 'myapp.example.com',
  name: 'open_dialogs', code: "result = helpers.byClass('Dialog').length",
  expect: 'flat'})
```

Probes are saved in named sets in `~/.memlab/probes.json`. When a set's
`match` is part of the round's URL filter, `memlab_ladder_probe`,
`memlab_ab_compare` and `memlab_analysis_battery` run it without being asked,
and print OK or VIOLATED for every probe with an `expect`. A set can also save
a `run_dir`. `memlab_eval_across({use: ['myapp']})`, with no `code`, then runs
every probe of the set on every rung of that round and returns one table with a
row per probe and a column per rung. With several sets, rows are named
`<set>/<probe>`, so probes of the same name in two sets both show. A probe that
throws or does not parse gets an `error: …` cell, and the other probes on that
rung still run. An unknown set name is an error.

Three helpers cover the counts such probes usually need:
`helpers.countShapes({name: [props]})` counts plain objects that have every
listed property, per name. `helpers.countStrings(regex, {prefix})` counts
matching strings. `helpers.detachedElements()` returns detached DOM elements
without the Blink records attached to them. You can also pass
`probes: "<set>"` to choose a set, or `probes: "none"` for none. On
`memlab_ladder_probe` and `memlab_ab_compare`, passing your own `metrics` also
turns the automatic choice off.

## Findings Index

`memlab_finding_index` remembers what earlier investigations found, so a new
one can `check` whether a finding is already known before investigating it.

A finding is identified by its retainer path, normalized. Some findings have
no stable path, so they are identified by a `kind` and its `keys` instead:

| `kind` | Keys |
| --- | --- |
| `update-queue` | `component`, and `hook_ordinal` or `setter` |
| `collection` | `class` (optionally `probe`) |
| `probe` | `probe` (optionally `set`) |
| `optimization` | `owner` and `waste_kind` (optionally `module`): memory a fix gives back at a steady size, not a leak |

```js
memlab_finding_index({action: 'record', kind: 'update-queue', round: 'r12',
  keys: {component: 'ChatList', hook_ordinal: 3, setter: 'setMenuOpen'}})
```

Other useful actions:

- `list` filters by `round`, `since_round`, `status`, `title` and `kind`.
- When a `check` finds no exact match, it lists likely matches. Attach the new
  sighting to one with `action: "reconfirm"`.
- `action: "batch"` runs several actions in one call, and returns one line
  per action.
- Pass `run_dir` to any action, and the round's name and workstream are read
  from its `run.json`.
- `verified_by_ab` records the A/B result that verified a fix
  (`{round, metric, off, on}`), and `record` and `check` print it next to the
  fix.
- `cover` records the combinations of interactions a round drove. With
  `run_dir`, it also records the served code revision and a hash of the
  feature-flag values, so two rounds that drove the same combinations against
  different code can be told apart.

To find the code behind a finding, `memlab_source_for_finding({fingerprint})`
reads the module and field names off its retainer path, and lists up to three
files with the lines that assign those fields. It needs
`MEMLAB_SOURCE_LOOKUP_CMD`, a shell command that prints the files for
`{module}`, and reads the files from `MEMLAB_SOURCE_ROOT` or the current
directory. It doesn't read a printed path outside that directory, and a
lookup command that fails says why rather than reporting "no file".

To show the status of the code change that fixed each finding, set
`MEMLAB_FIX_STATUS_CMD` to a shell command containing `{diff}`.
`MEMLAB_FIX_STATUS_TIMEOUT_MS` sets its timeout (20 seconds by default).
Answers are cached for ten minutes per change, a lookup that fails says why
(a timeout, the exit code, or the first line of its error output), and
`memlab_server_status` shows the last lookup's result.
