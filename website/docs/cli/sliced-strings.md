---
title: memlab sliced-strings
sidebar_label: sliced-strings
custom_edit_url: null
---

Find large strings kept alive by short substrings (V8 sliced strings) in a heap snapshot

```bash
memlab sliced-strings --snapshot <HEAP_SNAPSHOT_FILE>
```

## Examples

```bash
memlab sliced-strings --snapshot <HEAP_SNAPSHOT_FILE> --top 50 --output json
```

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--top`**: number of rows to report (default 30)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
