---
title: memlab analyze detached-DOM
sidebar_label: detached-DOM
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import analyze_detached_DOM_output from '!!raw-loader!../../_cli/output/analyze-detached-DOM.txt';

Get detached DOM elements

```bash
memlab analyze detached-DOM 
```

## Example output

<TerminalOutput output={analyze_detached_DOM_output} />

## How to read the output

`memlab analyze detached-DOM` lists the DOM elements that were removed from the document but are still in memory, sorted by retained size. Elements retained by another element in the list are left out, so each subtree appears once.

Each line is `@id type name: N edges, retained size, refs: [...]`. `edges` is the number of references the object holds, and `refs` lists the names of the references that point to it (empty when they are all array indexes or DOM children).

In this example, the closed dialog's rows (`Detached <div>`) are still in memory, along with the browser's data for them (`blink::NodeRareData`, `blink::EventTargetData`). To find out what keeps them alive, pass an `@id` to [`memlab trace`](../trace.md).

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--output`**: specify output format of the analysis (available options: 'text', 'json'; defaults to 'text')

The [universal options](../CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
