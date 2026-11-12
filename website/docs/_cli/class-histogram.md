`memlab class-histogram` counts the objects in one snapshot by class and sorts the classes by their total self size. It shows the top `--top` classes.

- `class` is the constructor name. Names in parentheses, like `(object elements)`, `(array)`, and `(string)`, are engine-internal storage. `system / ...` entries are engine metadata, `blink::...` entries are browser internals, and `Detached <tag>` entries are DOM elements no longer in the document.
- `self size` counts only the object itself, not what it references, so the shares add up to the snapshot's total.

In this example, `(object elements)` takes 37.3% of the heap in only 6 objects. That is the backing store of the 800KB `history` array. The 240 `Detached <div>` and 240 `Detached Text` are the rows of a closed dialog that are still in memory. [`memlab class-diff`](./class-diff.md) shows which of these classes grew during the run.
