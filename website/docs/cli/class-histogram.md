---
title: memlab class-histogram
sidebar_label: class-histogram
custom_edit_url: null
---

Print the number of objects and their total self size per class in a heap snapshot

```bash
memlab class-histogram --snapshot <HEAP_SNAPSHOT_FILE>
```

## Examples

```bash
memlab class-histogram --snapshot <HEAP_SNAPSHOT_FILE> --top 100
memlab class-histogram --snapshot <HEAP_SNAPSHOT_FILE> --name-pattern Detached
memlab class-histogram --snapshot <HEAP_SNAPSHOT_FILE> --output json
```

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--top`**: number of rows to report (default 30)
 * **`--name-pattern`**: only report classes whose name matches this case-insensitive regular expression (or plain text)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
