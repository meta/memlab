`memlab analyze collections-with-stale` finds collections (arrays, `Map`s, `Set`s, and objects) that hold stale objects. Stale objects are detached DOM elements and unmounted React Fiber nodes, which the app no longer uses.

Each entry is the collection's id and retained size, how many of its elements are stale, and the ids of the stale elements. For a `Map` or `Set`, the collection is its internal table.

In this example, the collection is the internal table of the global `openedDialogs` `Set`, and the stale element is the `<div class="settings">` of the closed dialog. The app adds each dialog to the `Set` but never deletes it when the dialog closes.
