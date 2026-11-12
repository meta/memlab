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

## Example output

```text
$ memlab script-census --snapshot /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
Snapshot  /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
  5 scripts keep 14.0 KB of source text, 0.7% of the heap
script                                                                  scripts  copies  source  extra copies
----------------------------------------------------------------------  -------  ------  ------  ------------
"(() => { const module = {}; \"use strict\";var g=Object.defineProp...        1       1  9.5 KB             -
http://localhost:3000/                                                       1       1  2.7 KB             -
"(function addPageBinding(type, name, prefix) { // Depending on the...        1       1  1.7 KB             -
"() {}"                                                                       1       1     0 B             -
"(empty source)"                                                              1       1     0 B             -
```

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--top`**: number of rows to report (default 30)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
