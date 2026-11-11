---
title: memlab heap-stats
sidebar_label: heap-stats
custom_edit_url: null
---

Split the memory in a heap snapshot into code, strings, JS arrays, system objects and native memory, and into loaded code vs memory the program allocated

```bash
memlab heap-stats --snapshot <HEAP_SNAPSHOT_FILE>
```

## Examples

```bash
memlab heap-stats --snapshot <HEAP_SNAPSHOT_FILE> --output json
```

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
