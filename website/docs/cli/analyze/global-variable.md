---
title: memlab analyze global-variable
sidebar_label: global-variable
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import analyze_global_variable_output from '!!raw-loader!../../_cli/output/analyze-global-variable.txt';

Get global variables in heap

```bash
memlab analyze global-variable 
```

## Example output

<TerminalOutput output={analyze_global_variable_output} />

## How to read the output

`memlab analyze global-variable` lists the properties of the global objects (`window` in a browser), sorted by the memory they retain. memlab leaves out the standard `window` properties it knows about, but engine and browser internals still fill the top of the list.

Each line is `--property--> @id type name: N edges, retained size, refs: [...]`. Look for names that belong to your app: here `eventBus` retains 672 bytes, and following it with [`memlab analyze object`](./object.md) or [`memlab trace`](../trace.md) leads to the dialog that its listener keeps alive. `2137 more references...` counts the global properties that were not printed.

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--output`**: specify output format of the analysis (available options: 'text', 'json'; defaults to 'text')

The [universal options](../CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
