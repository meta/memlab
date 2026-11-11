---
title: memlab native-contexts
sidebar_label: native-contexts
custom_edit_url: null
---

Split a heap snapshot by JavaScript realm (page, iframes, extension worlds, detached windows, Node.js vm contexts) and report the memory each one owns

```bash
memlab native-contexts --snapshot <HEAP_SNAPSHOT_FILE>
```

## Examples

```bash
memlab native-contexts --snapshot <HEAP_SNAPSHOT_FILE> --output json
```

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--top`**: number of rows to report (default 30)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
