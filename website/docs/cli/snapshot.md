---
title: memlab snapshot
sidebar_label: snapshot
custom_edit_url: null
---

Interact with web app and take heap snapshots

```bash
memlab snapshot --scenario <TEST_SCENARIO_FILE>
```

## Examples

```bash
memlab snapshot --scenario /tmp/test-scenario.js
memlab snapshot --scenario /tmp/test-scenario.js --work-dir /tmp/test-1/
```

## Example output

```text
$ memlab snapshot --scenario /tmp/memlab-example/scenarios/leak.js --work-dir /tmp/memlab-example/snapshot
page-load[765.2KB](baseline)[s1] > action-on-page[1.7MB](target)[s2] > revert[1.7MB](final)[s3]

total time: 46.4s
```

## How to read the output

`memlab snapshot` runs the scenario and saves the heap snapshots without looking for leaks.

`page-load[765.2KB](baseline)[s1] > action-on-page[1.7MB](target)[s2] > revert[1.7MB](final)[s3]` lists the steps of the scenario in order. Each step shows its name, the JS heap size after the step, its role, and the heap snapshot taken there (`s1` is `data/cur/s1.heapsnapshot` in the work directory):

- `baseline`: after the page at `url` loads.
- `target`: after `action` runs (here, opening the settings dialog).
- `final`: after `back` runs (here, closing it).

`total time` is how long the browser run took.

To look for leaks in these snapshots later, use [`memlab find-leaks`](./find-leaks.md) with the same `--work-dir`. To look at one snapshot, pass it to any heap command, e.g. [`memlab heap-stats`](./heap-stats.md) `--snapshot <work-dir>/data/cur/s3.heapsnapshot`.

## Options

 * **`--headful`**: start the browser in headful mode, by default it is headless
 * **`--display-leak-outlines`**: display leaked component outlines in headful browser; use this with the --headful option
 * **`--app`**: set name for onboarded web application
 * **`--interaction`**: set name for onboarded interaction
 * **`--full`**: take heap snapshot for every step in E2E interaction
 * **`--skip-snapshot`**: skip taking heap snapshots
 * **`--skip-screenshot`**: skip taking screenshots
 * **`--skip-gc`**: skip doing garbage collection in browser
 * **`--skip-scroll`**: skip scrolling target page in browser
 * **`--skip-extra-ops`**: skip doing extra interactions (e.g., scrolling and waiting) on target and final page
 * **`--run-mode`**: set running mode
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
 * **`--work-dir`**: set the working directory of the current run

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
