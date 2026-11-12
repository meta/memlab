---
title: memlab dom-audit
sidebar_label: dom-audit
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import dom_audit_output from '!!raw-loader!../_cli/output/dom-audit.txt';

Count the DOM elements attached to the document in a browser heap snapshot, by tag and by repeated element

```bash
memlab dom-audit --snapshot <HEAP_SNAPSHOT_FILE>
```

## Examples

```bash
memlab dom-audit --snapshot <HEAP_SNAPSHOT_FILE> --top 50 --output json
```

## Example output

<TerminalOutput output={dom_audit_output} />

## How to read the output

`memlab dom-audit` counts the elements that are in the document in one snapshot, by tag.

- The first line gives the number and size of the attached elements, plus the per-element style and data objects the browser keeps for them. Detached elements are not counted. Use [`memlab analyze detached-DOM`](./analyze.md#memlab-analyze-detached-dom) for those.
- The first table counts elements by tag.
- `Elements repeated 20 or more times` lists elements that appear in large numbers. Long lists are candidates for virtualization, which renders only the rows on screen.

This snapshot was taken while the settings dialog was open. Its 240 rows make `div` the most common element, and they show up as a candidate for virtualization.

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--top`**: number of rows to report (default 30)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
