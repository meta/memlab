---
id: 'guides-look-inside-a-heap-snapshot'
---

# Look Inside a Heap Snapshot

When a page uses more memory than you expect, a heap snapshot shows where
that memory is. This guide takes one snapshot and works from the top down:
what kind of memory it is, which objects hold it, and what keeps them alive.

## Get a Heap Snapshot

Any `.heapsnapshot` file works:

- memlab saves one after each step of a scenario, in the work directory's
  `data/cur` directory. This guide uses the last snapshot (`s3.heapsnapshot`)
  of the `leak.js` scenario from
  [Check Whether a Leak Fix Works](./07-check-a-leak-fix.md), taken after the
  settings dialog was opened and closed.
- In Chrome DevTools, take a heap snapshot in the **Memory** panel, then save
  it to disk.

Each command below reads the snapshot passed with `--snapshot`.

## 1. See What Kind of Memory It Is

```bash
memlab heap-stats --snapshot ~/memlab/leak/data/cur/s3.heapsnapshot
```

```
Snapshot  ~/memlab/leak/data/cur/s3.heapsnapshot
statistics            size   share
----------------  --------  ------
total               2.0 MB  100.0%
V8 heap             1.3 MB   62.9%
  code             45.4 KB    2.2%
  strings          54.3 KB    2.6%
  JS arrays       783.0 KB   37.3%
  system objects       0 B    0.0%
  other           437.3 KB   20.8%
native            779.1 KB   37.1%
  typed arrays         0 B    0.0%

why the memory exists                   size  share
-----------------------------------  -------  -----
script source text                   14.0 KB   0.7%
compiled code and function metadata  45.4 KB   2.2%
allocated by the program              2.0 MB  97.2%
```

The first table splits the total by where the memory lives: the JavaScript
heap (`V8 heap`) or outside it (`native`, such as DOM nodes). Here
`JS arrays` takes 37.3% of the memory, which is a lot for a page with one
button and a dialog.

## 2. See Which Classes Use It

```bash
memlab class-histogram --snapshot ~/memlab/leak/data/cur/s3.heapsnapshot --top 15
```

```
Snapshot  ~/memlab/leak/data/cur/s3.heapsnapshot
  top 15 of 5,293 classes by self size; 36,422 objects, 2.0 MB
class                                                                             type          count  self size  share
--------------------------------------------------------------------------------  ------------  -----  ---------  -----
(object elements)                                                                 array             6   782.8 KB  37.3%
system / FunctionTemplateInfo                                                     native        3,282   205.0 KB   9.8%
(object properties)                                                               array            59    94.9 KB   4.5%
(array)                                                                           array            40    93.4 KB   4.5%
...
Detached <div>                                                                    native          240    24.4 KB   1.2%
Detached Text                                                                     native          240    18.8 KB   0.9%
```

The classes are sorted by the total size of their objects. `(object elements)`
is the storage behind arrays and object elements: here only 6 of them take
37.3% of the memory. Further down, 240 `Detached <div>` and 240
`Detached Text` are the rows of the closed dialog, which are no longer in the
page but still in memory.

## 3. Find the Largest Objects

```bash
memlab analyze object-size --snapshot ~/memlab/leak/data/cur/s3.heapsnapshot
```

```
· @71395 Array: 3 edges, 800KB, refs: [history]
· @32151 Window (prototype) / http://localhost:3000: 535 edges, 26.7KB, refs: [__proto__, prototype]
· @46239 Window (prototype) / http://localhost:3000: 535 edges, 26.7KB, refs: [prototype, __proto__]
...
```

Each line is `@id type name: N edges, retained size, refs: [...]`. The retained
size is the memory that would be freed if the object went away, and `refs`
lists the names that point to it. The largest object by far is an 800KB
`Array` that something calls `history`.

## 4. Find Its Owner

In the app's code, `history` is a property of the `SettingsDialog` class. List
the objects of that class:

```bash
memlab find-objects --snapshot ~/memlab/leak/data/cur/s3.heapsnapshot --name-pattern '^SettingsDialog$'
```

```
Snapshot  ~/memlab/leak/data/cur/s3.heapsnapshot
  3 objects match; the 3 that retain the most:
id      class           type     self size  retained size  detached
------  --------------  -------  ---------  -------------  --------
@71391  SettingsDialog  object        60 B       787.7 KB
@48235  SettingsDialog  closure       32 B         1.7 KB
@11507  SettingsDialog  string        28 B           28 B
  why one is kept alive: memlab trace --snapshot ~/memlab/leak/data/cur/s3.heapsnapshot --node-id 71391
```

`@71391` is a dialog object that retains 787.7 KB. Look at its references and
referrers:

```bash
memlab analyze object --snapshot ~/memlab/leak/data/cur/s3.heapsnapshot --node-id @71391
```

```
Heap node (object) @71391
 name: SettingsDialog
 # of references: 6
 # of referrers: 3
 shallow size: 60
 retained size: 806616
 dominator node: @71399

REFERENCES:
·  --container--> @65915 native Detached <div class="settings">: 7 edges, 45.3KB, refs: [container]
·  --labels--> @71393 Array: 243 edges, 6.2KB, refs: [labels]
·  --history--> @71395 Array: 3 edges, 800KB, refs: [history]
·  --unsubscribe--> @71397 closure : 6 edges, 52 bytes, refs: [unsubscribe]
·  --__proto__--> @50821 Object { close, constructor, open }: 6 edges, 799 bytes, refs: [__proto__, prototype]
·  --map--> @71039 object shape system / Map: 15 edges, 224 bytes, refs: [map, transition]

REFERRERS:
·  @71399 system / Context / scope @65777: 5 edges, 806.6KB, refs: [listener] --dialog-->
·  @71399 system / Context / scope @65777: 5 edges, 806.6KB, refs: [listener] --this-->
·  @65917 WeakRef: 3 edges, 16 bytes, refs: [] --target-->
```

Its `history` reference is the 800KB array `@71395` from step 3. So the closed
dialog is still in memory, with everything it references.

## 5. Find Out What Keeps It Alive

```bash
memlab trace --snapshot ~/memlab/leak/data/cur/s3.heapsnapshot --node-id @71391
```

```
[Window / http://localhost:3000] (native) @33471 [7.6KB]
  --global_object (shortcut)--->  [Window [JSGlobalObject] / http://localhost:3000] (object) @33803 [46.1KB]
  --eventBus (property)--->  [Object] (object) @47965 [672 bytes]
  --listeners (property)--->  [Array] (object) @50799 [232 bytes]
  --0 (element)--->  [Object] (object) @65911 [140 bytes]
  --listener (property)--->  [handleThemeChange] (closure) @72371 [32 bytes]
  --context (internal)--->  [system / Context / scope (object) @71399 [806.6KB]
  --this (variable)--->  [SettingsDialog] (object) @71391 [806.6KB]
```

Read the trace from the top: the global `eventBus` keeps a list of
`listeners`. One of them is the dialog's `handleThemeChange` function, which
captured the dialog in its closure scope (`context`, then `this`). The dialog
never unsubscribes from the `eventBus` when it closes. Unsubscribing in
`close()` frees the dialog and its 800KB `history` array.

## Next Steps

- [`memlab view-heap`](../cli/view-heap.md) opens the snapshot in an
  interactive terminal viewer, to follow references in both directions.
- [`memlab analyze`](../cli/analyze.md) lists more analyses, such as
  duplicated strings and detached DOM elements.
- [`memlab class-diff`](../cli/class-diff.md) compares two snapshots class by
  class.
