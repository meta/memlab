`memlab find-leaks` runs the leak detection of [`memlab run`](./run.md) again on snapshots that were already taken, here the ones in the `--work-dir` of an earlier `memlab run`.

The **memory chart** has one bar per step, showing the JS heap size in MB. Here the heap doubles when the dialog opens (step 2) and does not drop when it closes (step 3). Memory that closing the dialog should have freed is still in use.

`MemLab found 1 leak(s)` counts the groups of leaked objects. A leaked object is one that was allocated during the `target` step and is still alive in the `final` snapshot, and that memlab's leak filter flags. By default, that means detached DOM elements, unmounted React Fiber nodes, and objects with a large retained size.

Each leak is printed as a **retainer trace**: the chain of references that keeps the leaked objects alive, read top to bottom from a GC root to the leaked object.

- Each object line is `[name] (type) @id [retained size]`. The retained size is how much memory would be freed if nothing else referenced that object.
- Each arrow is `--name (type)--->`, the reference from the line above to the line below. `property` is a named property, `element` an array index (or a child DOM node), `internal` an engine field, and `variable` a variable captured by a closure.
- `Similar leaks in this run: 386` is how many leaked objects have a trace like this one. memlab groups them and prints one representative. `Retained size of leaked objects` is their total retained size.

In this example, closing the settings dialog removes its `<div class="settings">` from the page, but the global `openedDialogs` `Set` still holds it, so the detached element and its 240 rows stay in memory. The fix is to delete the element from the `Set` when the dialog closes. Use the `@id`s with [`memlab trace`](./trace.md) or [`memlab view-heap`](./view-heap.md) to look closer.
