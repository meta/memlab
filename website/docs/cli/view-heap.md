---
title: memlab view-heap
sidebar_label: view-heap
custom_edit_url: null
---

Interactive command to view a single heap snapshot

```bash
memlab view-heap --snapshot <HEAP_SNAPSHOT_FILE>
```

## Example output

```text
$ memlab view-heap --snapshot /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
┌─Referrers of @65915 (press 1 to ─────┐┌─Clustered Objects (press 3 to focus) ┐┌─References of @65915 (press 4 to ────┐
│[blink::FormController](native) @5170 ││[Cluster] [Detached <div class="settin││--7(element)---> [Detached <div       │
│[Detached <button id="close-settings">││                                      ││--5(element)---> [Detached <div>](nati│
│[Detached <div>](native) @72363 [184  ││                                      ││--6(element)---> [HTMLDocument](native│
│[Detached <div>](native) @72361 [184  ││                                      ││--3 / part of key (<div class="setting│
│[Detached <div>](native) @72359 [184  ││                                      ││--4(element)---> [Detached blink::Uniq│
│[Detached <div>](native) @72357 [184  ││                                      ││--__proto__(property)---> [HTMLDivElem│
│[Detached <div>](native) @72355 [184  ││                                      ││--map(internal)---> [system / Map](obj│
│[Detached <div>](native) @72353 [184  ││                                      ││                                      │
│[Detached <div>](native) @72351 [184  ││                                      ││                                      │
│[Detached <div>](native) @72349 [184  ││                                      ││                                      │
│[Detached <div>](native) @72347 [184  ││                                      ││                                      │
│[Detached <div>](native) @72345 [184  ││                                      ││                                      │
│[Detached <div>](native) @72343 [184  ││                                      ││                                      │
│[Detached <div>](native) @72341 [184  ││                                      │└──────────────────────────────────────┘
│[Detached <div>](native) @72339 [184  ││                                      │┌─Retainer Trace of @65915 (press 6 to ┐
│[Detached <div>](native) @72337 [184  ││                                      ││[Window / http://localhost:3000](nati│
│[Detached <div>](native) @72335 [184  ││                                      ││--global_object(shortcut)---> [Window │
│[Detached <div>](native) @72333 [184  ││                                      ││--openedDialogs(property)---> [Set](ob│
│[Detached <div>](native) @72331 [184  ││                                      ││--table(internal)---> [](array)       │
│[Detached <div>](native) @72329 [184  ││                                      ││--5(internal)---> [Detached <div      │
└──────────────────────────────────────┘│                                      ││                                      │
┌─Objects (press 2 to focus) 1 items───┐│                                      ││                                      │
│[Detached] [Detached <div class="setti││                                      ││                                      │
│                                      ││                                      ││                                      │
│                                      ││                                      ││                                      │
│                                      ││                                      ││                                      │
│                                      ││                                      ││                                      │
│                                      ││                                      ││                                      │
│                                      │└──────────────────────────────────────┘│                                      │
│                                      │┌─Object: @65915 (press 5 to focus) 10 ┐│                                      │
│                                      ││id: @65915                            ││                                      │
│                                      ││name: Detached <div class="settings"> ││                                      │
│                                      ││type: native                          ││                                      │
│                                      ││self size: 104 bytes                  ││                                      │
│                                      ││retained size: 45.3KB                 ││                                      │
│                                      ││# of references: 7                    ││                                      │
│                                      ││# of referrers: 245                   ││                                      │
│                                      ││dominator node: [(GC roots)](synthetic││                                      │
│                                      ││# of clusters: 1                      ││                                      │
│                                      ││aggregated retained size: 45.3KB      ││                                      │
│                                      ││                                      ││                                      │
│                                      ││                                      ││                                      │
└──────────────────────────────────────┘└──────────────────────────────────────┘└──────────────────────────────────────┘
 Keys: ↑ ↓ ← → Enter(select) f(full screen) q(quit) 1 2 3 4 5 6
```

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--node-id`**: set heap node ID
 * **`--ml-clustering`**: use machine learning algorithms for clustering leak traces (by default, traces are clustered by heuristics)
 * **`--work-dir`**: set the working directory of the current run
 * **`--heap-parser-dict-fast-store-size`**: the size threshold for switching from fast store to slower store in the heap snapshot parser. The default value is 5,000,000. If you get the `FATAL ERROR: invalid table size Allocation failed - JavaScript heap out of memory` error, try to decrease the threshold here

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
