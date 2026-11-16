---
id: 'guides-look-inside-a-heap-snapshot'
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import heap_stats_output from '!!raw-loader!./_output/09-heap-stats.txt';
import class_histogram_output from '!!raw-loader!./_output/09-class-histogram.txt';
import object_size_output from '!!raw-loader!./_output/09-object-size.txt';
import find_objects_output from '!!raw-loader!./_output/09-find-objects.txt';
import analyze_object_output from '!!raw-loader!./_output/09-analyze-object.txt';
import trace_output from '!!raw-loader!./_output/09-trace.txt';

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

<TerminalOutput output={heap_stats_output} />

The first table splits the total by where the memory lives: the JavaScript
heap (`V8 heap`) or outside it (`native`, such as DOM nodes). Here
`JS arrays` takes 37.3% of the memory, which is a lot for a page with one
button and a dialog.

## 2. See Which Classes Use It

```bash
memlab class-histogram --snapshot ~/memlab/leak/data/cur/s3.heapsnapshot --top 15
```

<TerminalOutput output={class_histogram_output} />

The classes are sorted by the total size of their objects. `(object elements)`
is the storage behind arrays and object elements: here only 6 of them take
37.3% of the memory. Further down, 240 `Detached <div>` and 240
`Detached Text` are the rows of the closed dialog, which are no longer in the
page but still in memory.

## 3. Find the Largest Objects

```bash
memlab analyze object-size --snapshot ~/memlab/leak/data/cur/s3.heapsnapshot
```

<TerminalOutput output={object_size_output} />

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

<TerminalOutput output={find_objects_output} />

`@71391` is a dialog object that retains 787.7 KB. Look at its references and
referrers:

```bash
memlab analyze object --snapshot ~/memlab/leak/data/cur/s3.heapsnapshot --node-id @71391
```

<TerminalOutput output={analyze_object_output} />

Its `history` reference is the 800KB array `@71395` from step 3. So the closed
dialog is still in memory, with everything it references.

## 5. Find Out What Keeps It Alive

```bash
memlab trace --snapshot ~/memlab/leak/data/cur/s3.heapsnapshot --node-id @71391
```

<TerminalOutput output={trace_output} />

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
