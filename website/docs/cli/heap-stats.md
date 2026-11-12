---
title: memlab heap-stats
sidebar_label: heap-stats
custom_edit_url: null
---

Split the memory in a heap snapshot into code, strings, JS arrays, system objects and native memory, and into loaded code vs memory the program allocated

```bash
memlab heap-stats --snapshot <HEAP_SNAPSHOT_FILE>
```

## Examples

```bash
memlab heap-stats --snapshot <HEAP_SNAPSHOT_FILE> --output json
```

## Example output

```text
$ memlab heap-stats --snapshot /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
Snapshot  /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
statistics            size   share
----------------  --------  ------
total               2.0 MB  100.0%
V8 heap             1.3 MB   62.9%
  code             45.4 KB    2.2%
  strings          54.3 KB    2.6%
  JS arrays       783.0 KB   37.3%
  system objects       0 B    0.0%
  other           437.3 KB   20.8%
native            779.1 KB   37.1%
  typed arrays         0 B    0.0%

why the memory exists                   size  share
-----------------------------------  -------  -----
script source text                   14.0 KB   0.7%
compiled code and function metadata  45.4 KB   2.2%
allocated by the program              2.0 MB  97.2%
```

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
