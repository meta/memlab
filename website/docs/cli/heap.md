---
title: memlab heap
sidebar_label: heap
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import heap_output from '!!raw-loader!../_cli/output/heap.txt';

Interactive command to explore a single heap snapshot

```bash
memlab heap --snapshot <HEAP_SNAPSHOT_FILE>
```

## Example output

<TerminalOutput output={heap_output} />

## How to read the output

`memlab heap` loads a snapshot and opens a prompt where you can run commands against it without loading it again. That is faster than separate commands for large snapshots.

In this example, `trace --node-id` prints the retainer trace of a `SettingsDialog`, read the same way as with [`memlab trace`](./trace.md). The prompt supports `trace`, `analyze`, and `help`, with the same options as the CLI commands of the same name, minus `--snapshot`. Type `exit` or press Ctrl+C twice to leave.

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--heap-parser-dict-fast-store-size`**: the size threshold for switching from fast store to slower store in the heap snapshot parser. The default value is 5,000,000. If you get the `FATAL ERROR: invalid table size Allocation failed - JavaScript heap out of memory` error, try to decrease the threshold here

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
