---
title: memlab class-histogram
sidebar_label: class-histogram
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import class_histogram_output from '!!raw-loader!../_cli/output/class-histogram.txt';

Print the number of objects and their total self size per class in a heap snapshot

```bash
memlab class-histogram --snapshot <HEAP_SNAPSHOT_FILE>
```

## Examples

```bash
memlab class-histogram --snapshot <HEAP_SNAPSHOT_FILE> --top 100
memlab class-histogram --snapshot <HEAP_SNAPSHOT_FILE> --name-pattern Detached
memlab class-histogram --snapshot <HEAP_SNAPSHOT_FILE> --output json
```

## Example output

<TerminalOutput output={class_histogram_output} />

## How to read the output

`memlab class-histogram` counts the objects in one snapshot by class and sorts the classes by their total self size. It shows the top `--top` classes.

- `class` is the constructor name. Names in parentheses, like `(object elements)`, `(array)`, and `(string)`, are engine-internal storage. `system / ...` entries are engine metadata, `blink::...` entries are browser internals, and `Detached <tag>` entries are DOM elements no longer in the document.
- `self size` counts only the object itself, not what it references, so the shares add up to the snapshot's total.

In this example, `(object elements)` takes 37.3% of the heap in only 6 objects. That is the backing store of the 800KB `history` array. The 240 `Detached <div>` and 240 `Detached Text` are the rows of a closed dialog that are still in memory. [`memlab class-diff`](./class-diff.md) shows which of these classes grew during the run.

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--top`**: number of rows to report (default 30)
 * **`--name-pattern`**: only report classes whose name matches this case-insensitive regular expression (or plain text)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
