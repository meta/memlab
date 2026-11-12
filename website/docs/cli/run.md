---
title: memlab run
sidebar_label: run
custom_edit_url: null
---

Find memory leaks in web apps

```bash
memlab run --scenario <TEST_SCENARIO_FILE>
```

## Examples

```bash
memlab run --scenario /tmp/test-scenario.js
memlab run --scenario /tmp/test-scenario.js --work-dir /tmp/test-1/
```

## Example output

```text
$ memlab run --scenario /tmp/memlab-example/scenarios/leak.js --work-dir /tmp/memlab-example/leak
page-load[765.2KB](baseline)[s1] > action-on-page[1.7MB](target)[s2] > revert[1.7MB](final)[s3]

total time: 46.4s
Memory usage across all steps:
2.0
1.7
1.5    ██ ██
1.2    ██ ██
1.0    ██ ██
0.7    ██ ██
0.5 ██ ██ ██
0.2 ██ ██ ██
0.0 ██ ██ ██
    1  2  3

MemLab found 1 leak(s)
Number of clusters loaded: 0

--Similar leaks in this run: 386--
--Retained size of leaked objects: 45.3KB--
[Window / http://localhost:3000] (native) @33471 [7.6KB]
  --global_object (shortcut)--->  [Window [JSGlobalObject] / http://localhost:3000] (object) @33803 [46.1KB]
  --openedDialogs (property)--->  [Set] (object) @47967 [76 bytes]
  --table (internal)--->  [<array>] (array) @50805 [60 bytes]
  --5 (internal)--->  [Detached <div class="settings"> (native) @65915 [45.3KB]
  --5 (element)--->  [Detached <div> (native) @71885 [45KB]
  --7 (element)--->  [Detached <button id="close-settings"> (native) @72365 [812 bytes]
  --9 (element)--->  [Detached <div> (native) @72363 [184 bytes]
  --4 (element)--->  [Detached Text] (native) @15810 [80 bytes]
```

## Options

 * **`--work-dir`**: set the working directory of the current run
 * **`--headful`**: start the browser in headful mode, by default it is headless
 * **`--display-leak-outlines`**: display leaked component outlines in headful browser; use this with the --headful option
 * **`--full`**: take heap snapshot for every step in E2E interaction
 * **`--skip-screenshot`**: skip taking screenshots
 * **`--skip-gc`**: skip doing garbage collection in browser
 * **`--skip-scroll`**: skip scrolling target page in browser
 * **`--skip-extra-ops`**: skip doing extra interactions (e.g., scrolling and waiting) on target and final page
 * **`--local-puppeteer`**: enable remote browser instance debugging via local puppeteer
 * **`--scenario`**: set file path loading test scenario
 * **`--chromium-binary`**: set the chromium binary for E2E run
 * **`--protocol-timeout`**: set the protocol timeout for chromium connection (in ms). 
The current default value is 180000, you may want to increase the timeout via this flag when the heap snapshot is too big (e.g., over 1GB) and the Page crashed with error: 'ProtocolError: HeapProfiler.takeHeapSnapshot timed out'.
 * **`--device`**: set the device type to emulate
 * **`--user-agent`**: set the UserAgent string in browser (for E2E interaction), otherwise it uses the default UserAgent from Chromium
 * **`--disable-xvfb`**: disable Xvfb (X virtual framebuffer) for simulating headful browser rendering
 * **`--disable-web-security`**: disable web security in Chromium to enable cross domain requests; web security is enabled by default
 * **`--rewrite-js`**: enable instrument JavaScript code in browser
 * **`--log-script`**: enable intercepting and logging JavaScript code in browser
 * **`--worker`**: set title of the target (worker) that needs to be selected and analyzed
 * **`--leak-filter`**: specify a definition JS file for leak filter
 * **`--trace-object-size-above`**: objects with retained size (bytes) bigger than the threshold will be considered as leaks
 * **`--ignore-leak-cluster-size-below`**: ignore memory leaks with aggregated retained size smaller than the threshold (in bytes)
 * **`--trace-all-objects`**: dump retainer trace for all allocated objects (ignore the leak filter), available option modes: --trace-all-objects=selected-js-objects, --trace-all-objects=default
 * **`--save-trace-as-unclassified-cluster`**: dump each retainer trace as an unclassified trace cluster
 * **`--ml-clustering`**: use machine learning algorithms for clustering leak traces (by default, traces are clustered by heuristics)
 * **`--ml-linkage-max-dist`**: set linkage max distance value for clustering. The value should be between [0, 1] inclusive.
 * **`--ml-clustering-max-df`**: set percentage based max document frequency for limiting the terms that appear too often
 * **`--clean-up-snapshot`**: clean up heap snapshots after running

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
