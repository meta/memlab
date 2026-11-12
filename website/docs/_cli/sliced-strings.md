`memlab sliced-strings` finds strings made by slicing a longer string. V8 can keep a slice as a pointer into its parent string instead of a copy, so a short slice can keep a long parent string alive.

- The second line tells how much memory is kept alive only by slices. That memory would be freed by copying the slices into strings of their own.
- In the table, each row is a parent string with the number of slices pointing into it. `only slices hold it` tells whether anything other than slices references it.

In this example, the dialog cuts its 240 row labels out of one 6.8 KB string. The parent is still referenced directly (`no`), so the slices cost nothing extra here. If the app dropped its own reference to the long string, the slices would keep all of it alive.
