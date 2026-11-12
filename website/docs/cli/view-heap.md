---
title: memlab view-heap
sidebar_label: view-heap
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import view_heap_output from '!!raw-loader!../_cli/output/view-heap.txt';

Interactive command to view a single heap snapshot

```bash
memlab view-heap --snapshot <HEAP_SNAPSHOT_FILE>
```

## Example output

<TerminalOutput output={view_heap_output} />

## How to read the output

`memlab view-heap` opens an interactive viewer in the terminal. It starts with a list of objects worth a look: the detached DOM elements and the objects with the largest retained size. Press a number to move to a panel, the arrow keys to move within it, and Enter to select an object. The panels are:

1. **Referrers** of the selected object, i.e. what references it. Here these are the 240 rows, the close button, and other objects that point back to the dialog's `<div class="settings">`.
2. **Objects**, the starting list. Each entry is tagged with why it is listed, like `[Detached]`.
3. **Clustered Objects**, similar objects grouped together.
4. **References** of the selected object, i.e. what it references.
5. **Object**: details of the selected object, including its retained size, its numbers of references and referrers, and its dominator (the closest object that every path from a GC root goes through).
6. **Retainer Trace**: the chain of references that keeps the selected object alive. Here it goes through the global `openedDialogs` `Set`.

Selecting an object in panels 1, 4, or 6 makes it the selected object, so you can follow references in both directions.

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--node-id`**: set heap node ID
 * **`--ml-clustering`**: use machine learning algorithms for clustering leak traces (by default, traces are clustered by heuristics)
 * **`--work-dir`**: set the working directory of the current run
 * **`--heap-parser-dict-fast-store-size`**: the size threshold for switching from fast store to slower store in the heap snapshot parser. The default value is 5,000,000. If you get the `FATAL ERROR: invalid table size Allocation failed - JavaScript heap out of memory` error, try to decrease the threshold here

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
