---
title: memlab analyze unbound-shape
sidebar_label: unbound-shape
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import analyze_unbound_shape_output from '!!raw-loader!../../_cli/output/analyze-unbound-shape.txt';

Get shapes with unbound growth (a class of objects with growing aggregated retained size)

```bash
memlab analyze unbound-shape 
```

## Example output

<TerminalOutput output={analyze_unbound_shape_output} />

## How to read the output

`memlab analyze unbound-shape` compares a series of snapshots of the same page and lists the shapes (class and property names) whose total retained size keeps growing.

Each line is the shape, its number of objects and total retained size in each snapshot in order, and one example object id per snapshot. In this example, after the first time the dialog opens, strings grow by 240 every time it opens again: the dialog's row labels, which are still in memory after it closes.

## Options

 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis

The [universal options](../CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
