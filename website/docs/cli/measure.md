---
title: memlab measure
sidebar_label: measure
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import measure_output from '!!raw-loader!../_cli/output/measure.txt';

Run test scenario in measure mode

In some web apps, the heap size can show considerable variability across various runs. This fluctuation can often make it hard to understand the impact of memory leaks. The introduction of the measure mode aims to address this challenge by executing the same scenario repetitively, therefore getting multiple data points of JavaScript heap sizes. This can help understand if the heap size movements during specific runs come from memory-related issues or just noise.

```bash
memlab measure --scenario <TEST_SCENARIO_FILE>
```

## Examples

```bash
memlab measure --scenario /tmp/test-scenario.js
memlab measure --scenario /tmp/test-scenario.js --work-dir /tmp/test-1/
```

## Example output

<TerminalOutput output={measure_output} />

## How to read the output

`memlab measure` runs the scenario `--run-num` times to show how much the memory varies from run to run. Each run prints its own line of steps.

`page-load[765.2KB](baseline)[s1] > action-on-page[1.7MB](target)[s2] > revert[1.7MB](final)[s3]` lists the steps of the scenario in order. Each step shows its name, the JS heap size after the step, its role, and the heap snapshot taken there (`s1` is `data/cur/s1.heapsnapshot` in the work directory):

- `baseline`: after the page at `url` loads.
- `target`: after `action` runs (here, opening the settings dialog).
- `final`: after `back` runs (here, closing it).

`total time` is how long the browser run took.

Here both runs report the same sizes, so a difference of a few hundred KB between two versions of this app would be real, not noise. For apps whose heap varies more between runs, use more runs.

## Options

 * **`--headful`**: start the browser in headful mode, by default it is headless
 * **`--display-leak-outlines`**: display leaked component outlines in headful browser; use this with the --headful option
 * **`--run-num`**: set number of runs
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
 * **`--work-dir`**: set the working directory of the current run

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
