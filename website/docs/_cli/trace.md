`memlab trace` prints one retainer trace for the object `--node-id`: the chain of references that keeps it alive, from a GC root down to the object. Each line is `[name] (type) @id [retained size]`, and each arrow is the reference from the line above to the line below.

In this example, a `SettingsDialog` is still alive after its dialog closed. The trace shows why: the global `eventBus` keeps a `listeners` array, whose first entry holds the `handleThemeChange` function. That function captured the dialog through its closure scope (`context`, then the `this` variable). Removing the listener when the dialog closes frees the 806.6KB that the dialog retains.

memlab picks the trace that best explains the retention and skips weak references. To see every object that references a node, use [`memlab analyze object`](./analyze.md#memlab-analyze-object) or [`memlab view-heap`](./view-heap.md).
