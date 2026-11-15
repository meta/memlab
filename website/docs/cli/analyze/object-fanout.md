---
title: memlab analyze object-fanout
sidebar_label: object-fanout
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import analyze_object_fanout_output from '!!raw-loader!../../_cli/output/analyze-object-fanout.txt';

Get objects with the most out-going references in heap

```bash
memlab analyze object-fanout 
```

## Example output

<TerminalOutput output={analyze_object_fanout_output} />

## How to read the output

`memlab analyze object-fanout` lists the objects with the most outgoing references. A collection with a huge number of entries is often a cache or registry that never removes anything.

Each line is `@id type name: N edges, retained size, refs: [...]`, where `refs` lists the names of the references that point to the object. The top entries in a browser are usually engine and DOM metadata (`DescriptorArray`, `Window`, `Document`). Here the `Array` referenced as `labels`, with 243 edges, is the dialog's list of row labels.

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--output`**: specify output format of the analysis (available options: 'text', 'json'; defaults to 'text')

The [universal options](../CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
