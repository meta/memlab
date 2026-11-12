---
title: memlab find-objects
sidebar_label: find-objects
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import find_objects_output from '!!raw-loader!../_cli/output/find-objects.txt';

List the objects in a heap snapshot that match a class name, node type, retained size or detached state, largest retained size first

```bash
memlab find-objects --snapshot <HEAP_SNAPSHOT_FILE> --name-pattern ^Map$ --min-retained-size 1MB
```

## Examples

```bash
memlab find-objects --snapshot <HEAP_SNAPSHOT_FILE> --detached --node-type native
memlab find-objects --snapshot <HEAP_SNAPSHOT_FILE> --node-type closure --top 50 --output json
```

## Example output

<TerminalOutput output={find_objects_output} />

## How to read the output

`memlab find-objects` lists the objects whose name matches `--name-pattern` (a regular expression), sorted by retained size.

- `type` tells objects, closures, and strings apart. Here the `object` is a `SettingsDialog` instance, the `closure` is the `SettingsDialog` class itself, and the `string` is the text `"SettingsDialog"`.
- `retained size` is the memory that would be freed if the object were no longer referenced.
- `detached` marks detached DOM elements.

The last line is the command that shows why the top object is still alive. A `SettingsDialog` instance retaining 787.7 KB after every dialog was closed is worth tracing.

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--name-pattern`**: only report classes whose name matches this case-insensitive regular expression (or plain text)
 * **`--node-type`**: only include heap objects of this node type, e.g. object, closure, array, string, native
 * **`--min-retained-size`**: only include objects that retain at least this much memory, in bytes or with a unit (KB, MB, GB; powers of 1024)
 * **`--detached`**: only include detached objects (DOM elements, React fibers)
 * **`--top`**: number of rows to report (default 30)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
