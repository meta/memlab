---
title: memlab class-trend
sidebar_label: class-trend
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import class_trend_output from '!!raw-loader!../_cli/output/class-trend.txt';

Track the number of objects per class across a series of heap snapshots, and list the classes that grew at every step

```bash
memlab class-trend --snapshot-dir <DIR_CONTAINING_SNAPSHOTS>
```

## Examples

```bash
memlab class-trend --snapshot-dir <DIR> --name-pattern Detached --output json
```

## Example output

<TerminalOutput output={class_trend_output} />

## How to read the output

`memlab class-trend` follows the object count of every class across a series of snapshots, in file-name order, and lists the classes that changed the most.

- `trend` is `grows` for a class whose count grew at every step, `appeared` for one that was not in the first snapshot, `grew` or `shrank` for one whose count is higher or lower at the end, and `flat` for one that ended where it started. The classes that grow at every step come first.
- `counts` shows the count in the first two and the last two snapshots.
- `delta` and `self size delta` compare the last snapshot with the first.

In this example, the scenario opens and closes the settings dialog 4 times after the page loads (once, then 3 repeats), taking a snapshot after each step. `Detached <div>` and `Detached Text` grow by 240 every time the dialog closes, and `Detached <div class="settings">` reaches 4: each closed dialog stays in memory. A count that keeps climbing across repetitions of the same action points to a leak. A count that rises once and stays flat (like the `blink::` classes here) is usually a cache or one-time setup.

## Options

 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--top`**: number of rows to report (default 30)
 * **`--name-pattern`**: only report classes whose name matches this case-insensitive regular expression (or plain text)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
