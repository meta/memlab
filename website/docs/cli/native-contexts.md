---
title: memlab native-contexts
sidebar_label: native-contexts
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import native_contexts_output from '!!raw-loader!../_cli/output/native-contexts.txt';

Split a heap snapshot by JavaScript realm (page, iframes, extension worlds, detached windows, Node.js vm contexts) and report the memory each one owns

```bash
memlab native-contexts --snapshot <HEAP_SNAPSHOT_FILE>
```

## Examples

```bash
memlab native-contexts --snapshot <HEAP_SNAPSHOT_FILE> --output json
```

## Example output

<TerminalOutput output={native_contexts_output} />

## How to read the output

`memlab native-contexts` groups the heap by native context. A native context is a JavaScript realm: the main page and each iframe or worker realm has its own global object and built-ins.

- `owned` is the memory reachable only from that realm, and `share` is its part of the whole heap. `objects` is the number of objects it owns.
- `detached` marks a realm whose document is gone (for example, a removed iframe). Memory owned by a detached realm is usually a leak.
- `(shared by several realms)` is memory reachable from more than one realm, and `(no realm: engine internals)` belongs to the engine itself.

In this example, two realms have the page's URL: the page itself and an isolated realm that the browser automation (Puppeteer) adds to it. Neither is detached.

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--top`**: number of rows to report (default 30)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
