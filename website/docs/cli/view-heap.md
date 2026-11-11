---
title: memlab view-heap
sidebar_label: view-heap
custom_edit_url: null
---

Interactive command to view a single heap snapshot

```bash
memlab view-heap --snapshot <HEAP_SNAPSHOT_FILE>
```

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--node-id`**: set heap node ID
 * **`--ml-clustering`**: use machine learning algorithms for clustering leak traces (by default, traces are clustered by heuristics)
 * **`--work-dir`**: set the working directory of the current run
 * **`--heap-parser-dict-fast-store-size`**: the size threshold for switching from fast store to slower store in the heap snapshot parser. The default value is 5,000,000. If you get the `FATAL ERROR: invalid table size Allocation failed - JavaScript heap out of memory` error, try to decrease the threshold here

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
