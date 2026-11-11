---
title: memlab dom-audit
sidebar_label: dom-audit
custom_edit_url: null
---

Count the DOM elements attached to the document in a browser heap snapshot, by tag and by repeated element

```bash
memlab dom-audit --snapshot <HEAP_SNAPSHOT_FILE>
```

## Examples

```bash
memlab dom-audit --snapshot <HEAP_SNAPSHOT_FILE> --top 50 --output json
```

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--top`**: number of rows to report (default 30)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
