---
title: memlab analyze unbound-object
sidebar_label: unbound-object
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import analyze_unbound_object_output from '!!raw-loader!../../_cli/output/analyze-unbound-object.txt';

Check unbound object growth (a single object with growing retained size)

```bash
memlab analyze unbound-object 
```

## Example output

<TerminalOutput output={analyze_unbound_object_output} />

## How to read the output

`memlab analyze unbound-object` compares a series of snapshots of the same page and lists the objects whose retained size keeps growing.

Each line is the object and its id, then its retained size in each snapshot in order. In this example, the global object grows once, between the first and the second snapshot, and then stays flat. That is one-time setup, not a leak. A leak keeps growing with every repetition of the same action.

## Options

 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis

The [universal options](../CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
