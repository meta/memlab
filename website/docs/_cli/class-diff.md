`memlab class-diff` compares the classes of two snapshots and sorts them by how much their self size grew from `--baseline` to `--target`.

- `count` and `self size` are the values in the target snapshot, and `delta` is the change from the baseline.
- `new` is shown when both snapshots come from the same JS heap (the same page, without a reload). It counts objects of the class that were allocated after the baseline and are still alive. `-` is shown for native classes, whose ids cannot tell old objects from new ones.

In this example, the baseline is the page after it loaded and the target is after the dialog was opened and closed. Closing the dialog should leave the page as it was, but 5 new `(object elements)` stores add 782.8 KB, and 240 `Detached <div>`, 240 `Detached Text`, and 240 `(sliced string)` are new. Those are the dialog's history array, rows, and labels, all still alive.
