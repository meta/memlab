---
title: memlab trace
sidebar_label: trace
custom_edit_url: null
---

Report retainer trace of a specific node, use with --nodeId

```bash
memlab trace --node-id=<HEAP_OBJECT_ID>
```

## Examples

```bash
memlab trace --node-id=@3123123
memlab trace --node-id=128127
```

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--node-id`**: set heap node ID
 * **`--heap-parser-dict-fast-store-size`**: the size threshold for switching from fast store to slower store in the heap snapshot parser. The default value is 5,000,000. If you get the `FATAL ERROR: invalid table size Allocation failed - JavaScript heap out of memory` error, try to decrease the threshold here

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
