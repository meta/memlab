---
title: memlab diff-leaks
sidebar_label: diff-leaks
custom_edit_url: null
---

Find new memory leaks by diffing control and test heap snapshots

```bash
memlab diff-leaks 
```

## Options

 * **`--control-snapshot`**: set the single (target) snapshot of control run
 * **`--control-work-dir`**: set the working directory of the control run
 * **`--treatment-snapshot`**: set the single (target) snapshot of treatment run
 * **`--treatment-work-dir`**: set the working directory of the treatment run
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--leak-filter`**: specify a definition JS file for leak filter
 * **`--trace-object-size-above`**: objects with retained size (bytes) bigger than the threshold will be considered as leaks
 * **`--ignore-leak-cluster-size-below`**: ignore memory leaks with aggregated retained size smaller than the threshold (in bytes)
 * **`--trace-all-objects`**: dump retainer trace for all allocated objects (ignore the leak filter), available option modes: --trace-all-objects=selected-js-objects, --trace-all-objects=default
 * **`--save-trace-as-unclassified-cluster`**: dump each retainer trace as an unclassified trace cluster
 * **`--ml-clustering`**: use machine learning algorithms for clustering leak traces (by default, traces are clustered by heuristics)
 * **`--ml-linkage-max-dist`**: set linkage max distance value for clustering. The value should be between [0, 1] inclusive.
 * **`--ml-clustering-max-df`**: set percentage based max document frequency for limiting the terms that appear too often
 * **`--max-cluster-sample-size`**: specify the max number of leak traces as input to leak trace clustering algorithm. Big sample size will preserve more complete information, but may risk out-of-memory crash.
 * **`--trace-contains`**: set the node name or edge name to filter leak traces that contain the name
 * **`--heap-parser-dict-fast-store-size`**: the size threshold for switching from fast store to slower store in the heap snapshot parser. The default value is 5,000,000. If you get the `FATAL ERROR: invalid table size Allocation failed - JavaScript heap out of memory` error, try to decrease the threshold here
 * **`--work-dir`**: set the working directory of the current run

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
