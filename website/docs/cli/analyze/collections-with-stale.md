---
title: memlab analyze collections-with-stale
sidebar_label: collections-with-stale
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import analyze_collections_with_stale_output from '!!raw-loader!../../_cli/output/analyze-collections-with-stale.txt';

Analyze collections holding stale objects

```bash
memlab analyze collections-with-stale 
```

## Example output

<TerminalOutput output={analyze_collections_with_stale_output} />

## How to read the output

`memlab analyze collections-with-stale` finds collections (arrays, `Map`s, `Set`s, and objects) that hold stale objects. Stale objects are detached DOM elements and unmounted React Fiber nodes, which the app no longer uses.

Each entry is the collection's id and retained size, how many of its elements are stale, and the ids of the stale elements. For a `Map` or `Set`, the collection is its internal table.

In this example, the collection is the internal table of the global `openedDialogs` `Set`, and the stale element is the `<div class="settings">` of the closed dialog. The app adds each dialog to the `Set` but never deletes it when the dialog closes.

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--output`**: specify output format of the analysis (available options: 'text', 'json'; defaults to 'text')

The [universal options](../CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
