---
title: memlab diff-leaks
sidebar_label: diff-leaks
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import diff_leaks_output from '!!raw-loader!../_cli/output/diff-leaks.txt';

Find new memory leaks by diffing control and test heap snapshots

```bash
memlab diff-leaks 
```

## Example output

<TerminalOutput output={diff_leaks_output} />

## How to read the output

`memlab diff-leaks` finds the leaks of the treatment run that the control run does not have. Here the control run used the fixed version of the app, and the treatment run used the version that leaks.

- The **memory chart** shows the JS heap size in MB after each step of the control run (bars 1 to 3), then a gap (4 to 6), then each step of the treatment run (7 to 9). In the control run, the heap goes back down when the dialog closes (bar 3). In the treatment run, it stays up (bar 9).
- `[0] traces from control group` and `[386] traces from treatment group` count the leaked objects found in each run (one number per work directory).
- `MemLab found 1 new leak(s) in the treatment group` counts the leaks left after removing every leak whose trace also appears in the control run. The trace below it reads the same way as in [`memlab find-leaks`](./find-leaks.md).

The fixed app has no leak, so the treatment's leak is reported as new. That makes `diff-leaks` useful for checking a change: if the change adds a leak, it shows up here.

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
