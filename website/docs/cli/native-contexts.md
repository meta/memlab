---
title: memlab native-contexts
sidebar_label: native-contexts
custom_edit_url: null
---

Split a heap snapshot by JavaScript realm (page, iframes, extension worlds, detached windows, Node.js vm contexts) and report the memory each one owns

```bash
memlab native-contexts --snapshot <HEAP_SNAPSHOT_FILE>
```

## Examples

```bash
memlab native-contexts --snapshot <HEAP_SNAPSHOT_FILE> --output json
```

## Example output

```text
$ memlab native-contexts --snapshot /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
Snapshot  /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
  3 native contexts (realms); 80.1% of 2.0 MB is owned by one realm
context  realm                         detached     owned  share  objects
-------  ----------------------------  --------  --------  -----  -------
@7597    http://localhost:3000                    1.2 MB  58.3%    8,827
@7795    http://localhost:3000                  379.4 KB  18.1%    8,636
@7411    (no URL)                                 79.7 KB   3.8%    1,883
         (shared by several realms)              142.2 KB   6.8%    8,834
         (no realm: engine internals)            275.0 KB  13.1%    8,245
```

## How to read the output

`memlab native-contexts` groups the heap by native context. A native context is a JavaScript realm: the main page and each iframe or worker realm has its own global object and built-ins.

- `owned` is the memory reachable only from that realm, and `share` is its part of the whole heap. `objects` is the number of objects it owns.
- `detached` marks a realm whose document is gone (for example, a removed iframe). Memory owned by a detached realm is usually a leak.
- `(shared by several realms)` is memory reachable from more than one realm, and `(no realm: engine internals)` belongs to the engine itself.

In this example, two realms have the page's URL: the page itself and an isolated realm that the browser automation (Puppeteer) adds to it. Neither is detached.

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--top`**: number of rows to report (default 30)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
