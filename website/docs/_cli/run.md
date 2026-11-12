`memlab run` runs the scenario in a browser, takes a heap snapshot after each step, and then looks for leaks in them.

`page-load[765.2KB](baseline)[s1] > action-on-page[1.7MB](target)[s2] > revert[1.7MB](final)[s3]` lists the steps of the scenario in order. Each step shows its name, the JS heap size after the step, its role, and the heap snapshot taken there (`s1` is `data/cur/s1.heapsnapshot` in the work directory):

- `baseline`: after the page at `url` loads.
- `target`: after `action` runs (here, opening the settings dialog).
- `final`: after `back` runs (here, closing it).

`total time` is how long the browser run took.

The **memory chart** has one bar per step, showing the JS heap size in MB. Here the heap doubles when the dialog opens (step 2) and does not drop when it closes (step 3). Memory that closing the dialog should have freed is still in use.

`MemLab found 1 leak(s)` counts the groups of leaked objects. A leaked object is one that was allocated during the `target` step and is still alive in the `final` snapshot, and that memlab's leak filter flags. By default, that means detached DOM elements, unmounted React Fiber nodes, and objects with a large retained size. `Number of clusters loaded` is the number of leaks saved by earlier runs, used to tell new leaks from known ones (0 on a first run).

Each leak is printed as a **retainer trace**: the chain of references that keeps the leaked objects alive, read top to bottom from a GC root to the leaked object.

- Each object line is `[name] (type) @id [retained size]`. The retained size is how much memory would be freed if nothing else referenced that object.
- Each arrow is `--name (type)--->`, the reference from the line above to the line below. `property` is a named property, `element` an array index (or a child DOM node), `internal` an engine field, and `variable` a variable captured by a closure.
- `Similar leaks in this run: 386` is how many leaked objects have a trace like this one. memlab groups them and prints one representative. `Retained size of leaked objects` is their total retained size.

In this example, closing the settings dialog removes its `<div class="settings">` from the page, but the global `openedDialogs` `Set` still holds it, so the detached element and its 240 rows stay in memory. The fix is to delete the element from the `Set` when the dialog closes. Use the `@id`s with [`memlab trace`](./trace.md) or [`memlab view-heap`](./view-heap.md) to look closer.
