`memlab analyze shape` groups the objects by shape (their class and property names) and lists the shapes that retain the most memory in total.

- `Heap overall statistics` gives the memory held by React Fiber nodes and by `Error` objects.
- Each shape line gives its total retained size, the number of objects (`N`), and examples with their own retained size.
- The lines under a shape show its common referrers, as `[referrer] --reference-->: number of objects`.

In this example, the `SettingsDialog` shape and the closure scope (`system / Context`) that holds it both retain 806.6KB. That is the same memory, counted once per shape. The scope is referenced by `handleThemeChange`, the event bus listener that keeps the dialog alive.
