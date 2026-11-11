---
title: memlab script-census
sidebar_label: script-census
custom_edit_url: null
---

Report the source text of loaded scripts kept in a heap snapshot, and scripts kept in memory more than once

```bash
memlab script-census --snapshot <HEAP_SNAPSHOT_FILE>
```

## Examples

```bash
memlab script-census --snapshot <HEAP_SNAPSHOT_FILE> --top 50 --output json
```

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--top`**: number of rows to report (default 30)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
