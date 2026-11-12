---
title: memlab class-histogram
sidebar_label: class-histogram
custom_edit_url: null
---

Print the number of objects and their total self size per class in a heap snapshot

```bash
memlab class-histogram --snapshot <HEAP_SNAPSHOT_FILE>
```

## Examples

```bash
memlab class-histogram --snapshot <HEAP_SNAPSHOT_FILE> --top 100
memlab class-histogram --snapshot <HEAP_SNAPSHOT_FILE> --name-pattern Detached
memlab class-histogram --snapshot <HEAP_SNAPSHOT_FILE> --output json
```

## Example output

```text
$ memlab class-histogram --snapshot /tmp/memlab-example/leak/data/cur/s3.heapsnapshot --top 15
Snapshot  /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
  top 15 of 5,293 classes by self size; 36,422 objects, 2.0 MB
class                                                                             type          count  self size  share
--------------------------------------------------------------------------------  ------------  -----  ---------  -----
(object elements)                                                                 array             6   782.8 KB  37.3%
system / FunctionTemplateInfo                                                     native        3,282   205.0 KB   9.8%
(object properties)                                                               array            59    94.9 KB   4.5%
(array)                                                                           array            40    93.4 KB   4.5%
system / DescriptorArray                                                          object shape    755    90.2 KB   4.3%
system / Map                                                                      object shape  1,261    50.4 KB   2.4%
system / PropertyCell                                                             native        2,556    49.9 KB   2.4%
(string)                                                                          string        6,919    49.6 KB   2.4%
system / ArrayList                                                                native           60    44.1 KB   2.1%
blink::ImmutableCSSPropertyValueSet                                               native          433    43.6 KB   2.1%
blink::StyleRule                                                                  native          411    40.9 KB   2.0%
blink::HeapHashTableBacking<blink::HashTable<blink::ShapeCacheKey, blink::Key...  native            2    36.6 KB   1.7%
system / AccessorPair                                                             native        2,128    24.9 KB   1.2%
Detached <div>                                                                    native          240    24.4 KB   1.2%
Detached Text                                                                     native          240    18.8 KB   0.9%
```

## How to read the output

`memlab class-histogram` counts the objects in one snapshot by class and sorts the classes by their total self size. It shows the top `--top` classes.

- `class` is the constructor name. Names in parentheses, like `(object elements)`, `(array)`, and `(string)`, are engine-internal storage. `system / ...` entries are engine metadata, `blink::...` entries are browser internals, and `Detached <tag>` entries are DOM elements no longer in the document.
- `self size` counts only the object itself, not what it references, so the shares add up to the snapshot's total.

In this example, `(object elements)` takes 37.3% of the heap in only 6 objects. That is the backing store of the 800KB `history` array. The 240 `Detached <div>` and 240 `Detached Text` are the rows of a closed dialog that are still in memory. [`memlab class-diff`](./class-diff.md) shows which of these classes grew during the run.

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--top`**: number of rows to report (default 30)
 * **`--name-pattern`**: only report classes whose name matches this case-insensitive regular expression (or plain text)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
