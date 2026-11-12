---
title: memlab trace
sidebar_label: trace
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import trace_output from '!!raw-loader!../_cli/output/trace.txt';

Report retainer trace of a specific node, use with --nodeId

```bash
memlab trace --node-id=<HEAP_OBJECT_ID>
```

## Examples

```bash
memlab trace --node-id=@3123123
memlab trace --node-id=128127
```

## Example output

<TerminalOutput output={trace_output} />

## How to read the output

`memlab trace` prints one retainer trace for the object `--node-id`: the chain of references that keeps it alive, from a GC root down to the object. Each line is `[name] (type) @id [retained size]`, and each arrow is the reference from the line above to the line below.

In this example, a `SettingsDialog` is still alive after its dialog closed. The trace shows why: the global `eventBus` keeps a `listeners` array, whose first entry holds the `handleThemeChange` function. That function captured the dialog through its closure scope (`context`, then the `this` variable). Removing the listener when the dialog closes frees the 806.6KB that the dialog retains.

memlab picks the trace that best explains the retention and skips weak references. To see every object that references a node, use [`memlab analyze object`](./analyze.md#memlab-analyze-object) or [`memlab view-heap`](./view-heap.md).

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--node-id`**: set heap node ID
 * **`--heap-parser-dict-fast-store-size`**: the size threshold for switching from fast store to slower store in the heap snapshot parser. The default value is 5,000,000. If you get the `FATAL ERROR: invalid table size Allocation failed - JavaScript heap out of memory` error, try to decrease the threshold here

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
