---
custom_edit_url: null
---

# Command Line Interface

Install the memlab command line tool with npm:

```bash
npm install -g memlab
```

## COMMON Commands

| Command | Description |
| --- | --- |
| <a id="memlab-run"></a>[`memlab run`](./run.md) | Find memory leaks in web apps |
| <a id="memlab-anonymize"></a>[`memlab anonymize`](./anonymize.md) | Remove user data from a heap snapshot so it can be shared |
| <a id="memlab-find-leaks"></a>[`memlab find-leaks`](./find-leaks.md) | Find memory leaks in heap snapshots |
| <a id="memlab-class-diff"></a>[`memlab class-diff`](./class-diff.md) | Compare the number of objects and their self size per class between two heap snapshots |
| <a id="memlab-class-histogram"></a>[`memlab class-histogram`](./class-histogram.md) | Print the number of objects and their total self size per class in a heap snapshot |
| <a id="memlab-class-trend"></a>[`memlab class-trend`](./class-trend.md) | Track the number of objects per class across a series of heap snapshots, and list the classes that grew at every step |
| <a id="memlab-diff-leaks"></a>[`memlab diff-leaks`](./diff-leaks.md) | Find new memory leaks by diffing control and test heap snapshots |
| <a id="memlab-dom-audit"></a>[`memlab dom-audit`](./dom-audit.md) | Count the DOM elements attached to the document in a browser heap snapshot, by tag and by repeated element |
| <a id="memlab-find-objects"></a>[`memlab find-objects`](./find-objects.md) | List the objects in a heap snapshot that match a class name, node type, retained size or detached state, largest retained size first |
| <a id="memlab-trace"></a>[`memlab trace`](./trace.md) | Report retainer trace of a specific node, use with --nodeId |
| <a id="memlab-analyze"></a>[`memlab analyze`](./analyze.md) | Run heap analysis on heap snapshots. |
| <a id="memlab-heap-stats"></a>[`memlab heap-stats`](./heap-stats.md) | Split the memory in a heap snapshot into code, strings, JS arrays, system objects and native memory, and into loaded code vs memory the program allocated |
| <a id="memlab-native-contexts"></a>[`memlab native-contexts`](./native-contexts.md) | Split a heap snapshot by JavaScript realm (page, iframes, extension worlds, detached windows, Node.js vm contexts) and report the memory each one owns |
| <a id="memlab-script-census"></a>[`memlab script-census`](./script-census.md) | Report the source text of loaded scripts kept in a heap snapshot, and scripts kept in memory more than once |
| <a id="memlab-sliced-strings"></a>[`memlab sliced-strings`](./sliced-strings.md) | Find large strings kept alive by short substrings (V8 sliced strings) in a heap snapshot |
| <a id="memlab-snapshot-header"></a>[`memlab snapshot-header`](./snapshot-header.md) | Print node and edge counts and the memory needed to analyze a heap snapshot, read from its header without parsing the snapshot |
| <a id="memlab-weakref-census"></a>[`memlab weakref-census`](./weakref-census.md) | Count the WeakRefs in a heap snapshot, live vs empty, grouped by what holds them |
| <a id="memlab-heap"></a>[`memlab heap`](./heap.md) | Interactive command to explore a single heap snapshot |
| <a id="memlab-view-heap"></a>[`memlab view-heap`](./view-heap.md) | Interactive command to view a single heap snapshot |

## MISC Commands

| Command | Description |
| --- | --- |
| <a id="memlab-version"></a>[`memlab version`](./version.md) | Show the versions of all memlab packages installed |
| <a id="memlab-list"></a>[`memlab list`](./list.md) | List all test scenarios |
| <a id="memlab-reset"></a>[`memlab reset`](./reset.md) | Reset and initialize all directories |
| <a id="memlab-measure"></a>[`memlab measure`](./measure.md) | Run test scenario in measure mode |
| <a id="memlab-warmup"></a>[`memlab warmup`](./warmup.md) | Warm up the target app |
| <a id="memlab-help"></a>[`memlab help`](./help.md) | List all MemLab CLI commands or print helper text for a specific command |
| <a id="memlab-get-default-work-dir"></a>[`memlab get-default-work-dir`](./get-default-work-dir.md) | Query the default working directory |
| <a id="memlab-snapshot"></a>[`memlab snapshot`](./snapshot.md) | Interact with web app and take heap snapshots |
| <a id="memlab-warmup-and-snapshot"></a>[`memlab warmup-and-snapshot`](./warmup-and-snapshot.md) | Warm up server and take heap snapshots |

## Universal Options

These options work with every command:

 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output
