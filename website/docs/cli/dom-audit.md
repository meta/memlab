---
title: memlab dom-audit
sidebar_label: dom-audit
custom_edit_url: null
---

Count the DOM elements attached to the document in a browser heap snapshot, by tag and by repeated element

```bash
memlab dom-audit --snapshot <HEAP_SNAPSHOT_FILE>
```

## Examples

```bash
memlab dom-audit --snapshot <HEAP_SNAPSHOT_FILE> --top 50 --output json
```

## Example output

```text
$ memlab dom-audit --snapshot /tmp/memlab-example/leak/data/cur/s2.heapsnapshot
Snapshot  /tmp/memlab-example/leak/data/cur/s2.heapsnapshot
  250 attached elements (25.5 KB), plus 348 per-element style and data objects (27.9 KB)
  0 detached elements are not counted; see memlab analyze detached-DOM
tag     count  self size
------  -----  ---------
div       242    24.6 KB
button      2      352 B
script      1      144 B
body        1       96 B
meta        1       96 B
title       1       96 B
head        1       88 B
html        1       88 B

Elements repeated 20 or more times (candidates for list virtualization)
element  count  self size
-------  -----  ---------
div        241    24.5 KB
  each row is one element type; a list item built from several elements shows up as several rows with the same count
```

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
