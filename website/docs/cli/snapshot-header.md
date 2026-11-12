---
title: memlab snapshot-header
sidebar_label: snapshot-header
custom_edit_url: null
---

Print node and edge counts and the memory needed to analyze a heap snapshot, read from its header without parsing the snapshot

```bash
memlab snapshot-header --snapshot <HEAP_SNAPSHOT_FILE>
```

## Examples

```bash
memlab snapshot-header --snapshot-dir <DIR_CONTAINING_SNAPSHOTS>
memlab snapshot-header --snapshot <HEAP_SNAPSHOT_FILE> --output json
```

## Example output

```text
$ memlab snapshot-header --snapshot /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
Snapshot  /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
  file size             3.3 MB
  nodes                 36,425
  edges                 168,842 (4.6 per node)
  allocation stacks     not recorded
  detachedness          recorded
Memory needed to analyze it
  about 7 MB of JS heap; this Node.js process has 4,144 MB
```

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
