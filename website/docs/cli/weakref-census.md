---
title: memlab weakref-census
sidebar_label: weakref-census
custom_edit_url: null
---

Count the WeakRefs in a heap snapshot, live vs empty, grouped by what holds them

```bash
memlab weakref-census --snapshot <HEAP_SNAPSHOT_FILE>
```

## Examples

```bash
memlab weakref-census --snapshot <HEAP_SNAPSHOT_FILE> --output json
```

## Example output

```text
$ memlab weakref-census --snapshot /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
Snapshot  /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
  1 WeakRefs: 1 live, 0 empty (target already collected)
held by            WeakRefs  empty  share empty  example holder
-----------------  --------  -----  -----------  --------------
(object elements)         1      0         0.0%  @65919
```

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--top`**: number of rows to report (default 30)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
