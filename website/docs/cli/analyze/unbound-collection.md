---
title: memlab analyze unbound-collection
sidebar_label: unbound-collection
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import analyze_unbound_collection_output from '!!raw-loader!../../_cli/output/analyze-unbound-collection.txt';

Check unbound collection growth (e.g., Map with growing number of entries)

```bash
memlab analyze unbound-collection 
```

## Example output

<TerminalOutput output={analyze_unbound_collection_output} />

## How to read the output

`memlab analyze unbound-collection` compares a series of snapshots of the same page and lists the collections (`Map`, `Set`, and arrays) whose number of entries keeps growing.

Each line is the collection and its id, then its number of entries in each snapshot in order. Here the scenario opens and closes the settings dialog 4 times, taking a snapshot after each step. The `openedDialogs` `Set` gains one entry each time a dialog opens, and loses none when it closes. A collection that grows with every repetition of an action, and never shrinks, is a likely leak.

## Options

 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis

The [universal options](../CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
