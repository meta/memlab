---
title: memlab analyze
sidebar_label: analyze
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import analyze_output from '!!raw-loader!../_cli/output/analyze.txt';

Run heap analysis on heap snapshots.

```bash
memlab analyze <PLUGIN_NAME> [PLUGIN_OPTIONS]
```

## Example output

<TerminalOutput output={analyze_output} />

## How to read the output

Without a plugin name, `memlab analyze` lists the available analysis plugins and their options. Each plugin has its own page, listed below, with an example of its output.

## Subcommands

| Command | Description |
| --- | --- |
| <a id="memlab-analyze-unbound-collection"></a>[`memlab analyze unbound-collection`](./analyze/unbound-collection.md) | Check unbound collection growth (e.g., Map with growing number of entries) |
| <a id="memlab-analyze-collections-with-stale"></a>[`memlab analyze collections-with-stale`](./analyze/collections-with-stale.md) | Analyze collections holding stale objects |
| <a id="memlab-analyze-detached-dom"></a>[`memlab analyze detached-DOM`](./analyze/detached-DOM.md) | Get detached DOM elements |
| <a id="memlab-analyze-global-variable"></a>[`memlab analyze global-variable`](./analyze/global-variable.md) | Get global variables in heap |
| <a id="memlab-analyze-object"></a>[`memlab analyze object`](./analyze/object.md) | Get properties inside an object |
| <a id="memlab-analyze-object-fanout"></a>[`memlab analyze object-fanout`](./analyze/object-fanout.md) | Get objects with the most out-going references in heap |
| <a id="memlab-analyze-object-shallow"></a>[`memlab analyze object-shallow`](./analyze/object-shallow.md) | Get objects by key and value, without recursing into sub-objects |
| <a id="memlab-analyze-shape"></a>[`memlab analyze shape`](./analyze/shape.md) | List the shapes that retained most memory |
| <a id="memlab-analyze-object-size"></a>[`memlab analyze object-size`](./analyze/object-size.md) | Get the largest objects in heap |
| <a id="memlab-analyze-unbound-object"></a>[`memlab analyze unbound-object`](./analyze/unbound-object.md) | Check unbound object growth (a single object with growing retained size) |
| <a id="memlab-analyze-react-hooks"></a>[`memlab analyze react-hooks`](./analyze/react-hooks.md) | Show a memory breakdown of the most memory-consuming React components and their React hooks. This works best with unminified heap snapshots taken from React apps running in Dev mode. But also supports minified heap snapshots taken from React apps in production mode. |
| <a id="memlab-analyze-unbound-shape"></a>[`memlab analyze unbound-shape`](./analyze/unbound-shape.md) | Get shapes with unbound growth (a class of objects with growing aggregated retained size) |
| <a id="memlab-analyze-string"></a>[`memlab analyze string`](./analyze/string.md) | Find duplicated string instances in heap |
| <a id="memlab-analyze-unmounted-fiber-node"></a>[`memlab analyze unmounted-fiber-node`](./analyze/unmounted-fiber-node.md) | Get unmounted React Fiber nodes |

## Options

 * **`--analysis-plugin`**: specify the external heap analysis plugin file (must be a vanilla JS file ended with `Analysis.js` suffix)
 * **`--heap-parser-dict-fast-store-size`**: the size threshold for switching from fast store to slower store in the heap snapshot parser. The default value is 5,000,000. If you get the `FATAL ERROR: invalid table size Allocation failed - JavaScript heap out of memory` error, try to decrease the threshold here
 * **`--work-dir`**: set the working directory of the current run

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
