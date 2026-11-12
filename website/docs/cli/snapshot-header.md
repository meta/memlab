---
title: memlab snapshot-header
sidebar_label: snapshot-header
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import snapshot_header_output from '!!raw-loader!../_cli/output/snapshot-header.txt';

Print node and edge counts and the memory needed to analyze a heap snapshot, read from its header without parsing the snapshot

```bash
memlab snapshot-header --snapshot <HEAP_SNAPSHOT_FILE>
```

## Examples

```bash
memlab snapshot-header --snapshot-dir <DIR_CONTAINING_SNAPSHOTS>
memlab snapshot-header --snapshot <HEAP_SNAPSHOT_FILE> --output json
```

## Example output

<TerminalOutput output={snapshot_header_output} />

## How to read the output

`memlab snapshot-header` reads only the header of a snapshot file, so it is instant even for files of several GB. Use it to check a snapshot before analyzing it.

- `nodes` and `edges` are the number of objects and references in the snapshot.
- `allocation stacks` tells whether the snapshot recorded where each object was allocated.
- `detachedness` tells whether the browser marked detached DOM elements. memlab's leak detection uses this.
- `Memory needed to analyze it` estimates the JS heap memlab needs to load the snapshot, compared with what the current Node.js process can use. If the estimate is larger, pass a larger `--max-old-space-size` to Node.js.

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
