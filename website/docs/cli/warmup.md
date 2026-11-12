---
title: memlab warmup
sidebar_label: warmup
custom_edit_url: null
---

Warm up the target app

```bash
memlab warmup --scenario <TEST_SCENARIO_FILE>
```

## Examples

```bash
memlab warmup --scenario /tmp/test-scenario.js
```

## Example output

```text
$ memlab warmup --scenario /tmp/memlab-example/scenarios/leak.js
```

## How to read the output

`memlab warmup` opens the scenario's page in a few browser tabs, with the browser cache off, so that the web server is warmed up before measuring. It prints nothing when it succeeds. It is useful for a page whose first loads are slow, for example on a development server that compiles code on demand.

## Options

 * **`--headful`**: start the browser in headful mode, by default it is headless
 * **`--display-leak-outlines`**: display leaked component outlines in headful browser; use this with the --headful option
 * **`--app`**: set name for onboarded web application
 * **`--interaction`**: set name for onboarded interaction
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
 * **`--skip-warmup`**: skip warming up web server
 * **`--rewrite-js`**: enable instrument JavaScript code in browser
 * **`--log-script`**: enable intercepting and logging JavaScript code in browser
 * **`--work-dir`**: set the working directory of the current run

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
