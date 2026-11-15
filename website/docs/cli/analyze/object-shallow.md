---
title: memlab analyze object-shallow
sidebar_label: object-shallow
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import analyze_object_shallow_output from '!!raw-loader!../../_cli/output/analyze-object-shallow.txt';

Get objects by key and value, without recursing into sub-objects

```bash
memlab analyze object-shallow 
```

## Example output

<TerminalOutput output={analyze_object_shallow_output} />

## How to read the output

`memlab analyze object-shallow` finds objects with the same class and the same top-level keys and values, without comparing nested objects. Duplicated objects are candidates for sharing one instance.

- `All objects` gives the number and size of the objects compared, and how much of it is duplicated.
- `Top duplicated objects in count` shows `[number of copies, total size]` and the object, serialized. References to other objects appear as `REFERENCE_<id>`.
- `Top duplicated objects in size` shows `[total size, number of copies]` and some `node examples` to look at with [`memlab analyze object`](./object.md).

This small app has almost no duplication (0.06% of the size). The duplicated objects are empty objects and DOM wrappers.

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis

The [universal options](../CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
