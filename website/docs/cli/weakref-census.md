---
title: memlab weakref-census
sidebar_label: weakref-census
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import weakref_census_output from '!!raw-loader!../_cli/output/weakref-census.txt';

Count the WeakRefs in a heap snapshot, live vs empty, grouped by what holds them

```bash
memlab weakref-census --snapshot <HEAP_SNAPSHOT_FILE>
```

## Examples

```bash
memlab weakref-census --snapshot <HEAP_SNAPSHOT_FILE> --output json
```

## Example output

<TerminalOutput output={weakref_census_output} />

## How to read the output

`memlab weakref-census` counts the `WeakRef` objects in a snapshot and how many of them are empty.

- A `WeakRef` is `live` while its target is still alive, and `empty` once the target was garbage collected.
- The table groups `WeakRef`s by what holds them, with an example holder.

A growing number of empty `WeakRef`s means the code that holds them never removes them. In this example, the app keeps one `WeakRef` to the dialog, and it is still live: the dialog leaked, so it was never collected.

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--top`**: number of rows to report (default 30)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
