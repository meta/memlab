---
title: memlab class-diff
sidebar_label: class-diff
custom_edit_url: null
---

Compare the number of objects and their self size per class between two heap snapshots

```bash
memlab class-diff --baseline <HEAP_SNAPSHOT_FILE> --target <HEAP_SNAPSHOT_FILE>
```

## Examples

```bash
memlab class-diff --baseline <FILE> --target <FILE> --top 50 --name-pattern Detached
memlab class-diff --baseline <FILE> --target <FILE> --output json
```

## Options

 * **`--baseline`**: set file path of the baseline heap snapshot
 * **`--target`**: set file path of the target heap snapshot
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--top`**: number of rows to report (default 30)
 * **`--name-pattern`**: only report classes whose name matches this case-insensitive regular expression (or plain text)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
