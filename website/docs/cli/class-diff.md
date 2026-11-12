---
title: memlab class-diff
sidebar_label: class-diff
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import class_diff_output from '!!raw-loader!../_cli/output/class-diff.txt';

Compare the number of objects and their self size per class between two heap snapshots

```bash
memlab class-diff --baseline <HEAP_SNAPSHOT_FILE> --target <HEAP_SNAPSHOT_FILE>
```

## Examples

```bash
memlab class-diff --baseline <FILE> --target <FILE> --top 50 --name-pattern Detached
memlab class-diff --baseline <FILE> --target <FILE> --output json
```

## Example output

<TerminalOutput output={class_diff_output} />

## How to read the output

`memlab class-diff` compares the classes of two snapshots and sorts them by how much their self size grew from `--baseline` to `--target`.

- `count` and `self size` are the values in the target snapshot, and `delta` is the change from the baseline.
- `new` is shown when both snapshots come from the same JS heap (the same page, without a reload). It counts objects of the class that were allocated after the baseline and are still alive. `-` is shown for native classes, whose ids cannot tell old objects from new ones.

In this example, the baseline is the page after it loaded and the target is after the dialog was opened and closed. Closing the dialog should leave the page as it was, but 5 new `(object elements)` stores add 782.8 KB, and 240 `Detached <div>`, 240 `Detached Text`, and 240 `(sliced string)` are new. Those are the dialog's history array, rows, and labels, all still alive.

## Options

 * **`--baseline`**: set file path of the baseline heap snapshot
 * **`--target`**: set file path of the target heap snapshot
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--top`**: number of rows to report (default 30)
 * **`--name-pattern`**: only report classes whose name matches this case-insensitive regular expression (or plain text)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
