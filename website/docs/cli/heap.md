---
title: memlab heap
sidebar_label: heap
custom_edit_url: null
---

Interactive command to explore a single heap snapshot

```bash
memlab heap --snapshot <HEAP_SNAPSHOT_FILE>
```

## Example output

```text
$ memlab heap --snapshot /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
Heap Snapshot Loaded: /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
[memlab]$ trace --node-id @71391
[Window / http://localhost:3000] (native) @33471 [7.6KB]
  --global_object (shortcut)--->  [Window [JSGlobalObject] / http://localhost:3000] (object) @33803 [46.1KB]
  --eventBus (property)--->  [Object] (object) @47965 [672 bytes]
  --listeners (property)--->  [Array] (object) @50799 [232 bytes]
  --0 (element)--->  [Object] (object) @65911 [140 bytes]
  --listener (property)--->  [handleThemeChange] (closure) @72371 [32 bytes]
  --context (internal)--->  [system / Context / scope (object) @71399 [806.6KB]
  --this (variable)--->  [SettingsDialog] (object) @71391 [806.6KB]

Heap Snapshot Loaded: /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
[memlab]$
```

## How to read the output

`memlab heap` loads a snapshot and opens a prompt where you can run commands against it without loading it again. That is faster than separate commands for large snapshots.

In this example, `trace --node-id` prints the retainer trace of a `SettingsDialog`, read the same way as with [`memlab trace`](./trace.md). The prompt supports `trace`, `analyze`, and `help`, with the same options as the CLI commands of the same name, minus `--snapshot`. Type `exit` or press Ctrl+C twice to leave.

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--heap-parser-dict-fast-store-size`**: the size threshold for switching from fast store to slower store in the heap snapshot parser. The default value is 5,000,000. If you get the `FATAL ERROR: invalid table size Allocation failed - JavaScript heap out of memory` error, try to decrease the threshold here

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
