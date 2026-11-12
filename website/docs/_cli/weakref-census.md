`memlab weakref-census` counts the `WeakRef` objects in a snapshot and how many of them are empty.

- A `WeakRef` is `live` while its target is still alive, and `empty` once the target was garbage collected.
- The table groups `WeakRef`s by what holds them, with an example holder.

A growing number of empty `WeakRef`s means the code that holds them never removes them. In this example, the app keeps one `WeakRef` to the dialog, and it is still live: the dialog leaked, so it was never collected.
