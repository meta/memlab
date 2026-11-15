---
title: memlab analyze object
sidebar_label: object
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import analyze_object_output from '!!raw-loader!../../_cli/output/analyze-object.txt';

Get properties inside an object

```bash
memlab analyze object 
```

## Example output

<TerminalOutput output={analyze_object_output} />

## How to read the output

`memlab analyze object` prints one object, its references, and its referrers.

- `shallow size` and `retained size` are in bytes. The retained size is the memory freed if nothing referenced the object. `dominator node` is the closest object that every path from a GC root to this object goes through.
- `REFERENCES` are the objects this one points to, with the property name on the arrow.
- `REFERRERS` are the objects that point to this one, with the property name on the arrow after them.

In this example, the `SettingsDialog` retains 806.6KB, almost all of it in its 800KB `history` array. Its referrers show what keeps it alive: a closure scope that holds it as `dialog` and `this` (the scope of the event bus listener) and a `WeakRef`, which does not keep it alive.

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--node-id`**: set heap node ID
 * **`--output`**: specify output format of the analysis (available options: 'text', 'json'; defaults to 'text')

The [universal options](../CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
