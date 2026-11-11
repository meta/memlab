---
title: memlab class-trend
sidebar_label: class-trend
custom_edit_url: null
---

Track the number of objects per class across a series of heap snapshots, and list the classes that grew at every step

```bash
memlab class-trend --snapshot-dir <DIR_CONTAINING_SNAPSHOTS>
```

## Examples

```bash
memlab class-trend --snapshot-dir <DIR> --name-pattern Detached --output json
```

## Options

 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--top`**: number of rows to report (default 30)
 * **`--name-pattern`**: only report classes whose name matches this case-insensitive regular expression (or plain text)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
