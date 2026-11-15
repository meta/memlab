---
title: memlab analyze object-size
sidebar_label: object-size
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import analyze_object_size_output from '!!raw-loader!../../_cli/output/analyze-object-size.txt';

Get the largest objects in heap

```bash
memlab analyze object-size 
```

## Example output

<TerminalOutput output={analyze_object_size_output} />

## How to read the output

`memlab analyze object-size` lists the objects with the largest retained size. Objects retained by a larger object in the list are left out, so each line is a separate chunk of memory.

Each line is `@id type name: N edges, retained size, refs: [...]`, where `refs` lists the names of the references that point to the object. Here the top entry is an 800KB `Array` referenced as `history`: the history array of a settings dialog that was closed but is still in memory.

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--output`**: specify output format of the analysis (available options: 'text', 'json'; defaults to 'text')

The [universal options](../CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
