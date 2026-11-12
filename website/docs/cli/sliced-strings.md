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

## Example output

```text
$ memlab sliced-strings --snapshot /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
Snapshot  /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
  240 sliced strings point into 1 parent strings
  0 B in 0 parents is kept alive only by slices; copying the slices would free it
parent    size  slices  only slices hold it  text
------  ------  ------  -------------------  ------------------------------------------------------------
@47971  6.8 KB     240  no                   "Notification preference #000;Notification preference #00...
```

## How to read the output

`memlab sliced-strings` finds strings made by slicing a longer string. V8 can keep a slice as a pointer into its parent string instead of a copy, so a short slice can keep a long parent string alive.

- The second line tells how much memory is kept alive only by slices. That memory would be freed by copying the slices into strings of their own.
- In the table, each row is a parent string with the number of slices pointing into it. `only slices hold it` tells whether anything other than slices references it.

In this example, the dialog cuts its 240 row labels out of one 6.8 KB string. The parent is still referenced directly (`no`), so the slices cost nothing extra here. If the app dropped its own reference to the long string, the slices would keep all of it alive.

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--top`**: number of rows to report (default 30)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
