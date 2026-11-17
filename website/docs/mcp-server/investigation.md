---
title: Investigate a Heap Snapshot
---

You investigate in conversation: you ask questions, and the assistant picks
the tools. This page shows the steps a typical investigation goes through, and
what to know when you work with more than one snapshot.

## A Typical Investigation

1. **Load the snapshot.**
   "Load the heap snapshot at `/tmp/my-app.heapsnapshot`."
2. **See what the heap is made of.**
   "What is this heap made of?" The assistant splits the heap into your app's
   data, bundle source and V8 internals (`memlab_app_heap`), then looks at a
   class histogram and the largest retainers.
3. **Find what is growing.**
   With a series of snapshots taken while an interaction repeats: "Which
   classes grow in every snapshot?"
4. **Tell a leak from a working set.**
   "Does this growth level off, and is it given back after the page is idle
   and garbage-collected?" Steady growth over a short series can still be a
   bounded cache, or work that hasn't finished yet.
5. **Rule out noise.**
   "Is any of this held only by DevTools or a browser extension?"
6. **Explain why it is retained.**
   "Show me the retainer trace for node 48231, and tell me which reference to
   break." For three common causes, the tool that finds them points to a known
   fix (`memlab_fix_knowledge_check`) and the test that catches its usual
   mistake:
   - a `setState` call that changes nothing but still leaves update records
     behind,
   - an event listener added on every mount,
   - a stale value kept in a React Compiler memo cache.
7. **Confirm the fix.**
   Take a new series of snapshots after the fix, and ask whether the growth
   per repetition went down (`memlab_verify_fix`).

Not sure what to ask? Ask the assistant to call `memlab_tools`. It lists
every tool by the question it answers, which is the fastest way to find one
you didn't know about. See the [Tool Reference](./tools.md).

## Work with Several Snapshots

### Keep Snapshots Loaded

Leak detection needs a trend, not a single snapshot. When you load a snapshot,
pass `keep_previous: true` so the earlier ones stay loaded. Each loaded
snapshot gets a *handle*, by default its file name. If that name is already
taken, the new snapshot gets `<name>#2`; pass `alias` to choose a clearer
name.

`memlab_snapshots` lists the loaded snapshots, switches the *active* one that
tools read by default, and unloads the ones you are done with. Every loaded
snapshot holds its whole graph in memory, so unload what you don't need.
`memlab_server_status` shows how much memory the server uses.

### Ask About Any Snapshot Without Switching

Every tool that reads one snapshot also takes an optional `snapshot`: a
handle, or a `.heapsnapshot` path that is loaded for that call only. The
active snapshot doesn't change, so you can ask about two snapshots side by
side.

Tools that compare two snapshots take `baseline` and `target`. They can also
take a round directory (`run_dir`) and `rungs: [i, j]`, which default to its
first and last snapshot (see [Snapshot Ladders](./snapshot-ladders.md)).

### Match Objects Across Snapshots

V8 keeps an object's id for its whole lifetime, so the same id means the same
object across snapshots of one JavaScript isolate (one tab session without a
reload), and nowhere else. `memlab_diff_snapshots` detects that case and lists
the objects allocated between two snapshots that are still alive.

Within one isolate, an id also says when V8 first saw the object: heap objects
get odd ids in increasing order. In `memlab_eval`,
`helpers.newest(ids, n)` and `helpers.ageRank(id)` order objects by age, and
`helpers.maxObjectId()` saved from one snapshot splits the next one into
objects that already existed and objects allocated since.

Across isolates (after a reload, or in another tab), ids don't match. A
*stable key* does: `helpers.stableKey` in `memlab_eval` names a collection by
its path from a module scope (for example `Store.pendingById`), which is the
same in every snapshot. Save a `{stableKey → entries}` map with
`helpers.save` on one snapshot, read it back on the next with
`helpers.load(name, {allowCrossSnapshot: true})`, and compare.
`memlab_eval({mode: "recipes"})` has the full example.

:::tip Peek before you load

`memlab_snapshot_header` reads a snapshot's header without parsing the
snapshot: its node and edge counts, capture time, file size, and native
memory that no node accounts for (`extra_native_bytes`). It also says whether
the snapshot fits under the server's load limits, so you can pick a snapshot
that loads instead of trying one that is too large.

:::
