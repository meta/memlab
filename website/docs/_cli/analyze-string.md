`memlab analyze string` finds strings that are stored more than once. Duplicated strings can be shared, for example by reusing one constant, to save memory.

- `All strings` gives the number and size of the strings, and how much of it is duplicated.
- `Top duplicated strings in count` shows `[number of copies, total size]` and the string.
- `Top duplicated strings in size` shows `[total size, number of copies]` and some `node examples` to look at with [`memlab trace`](./trace.md).

This small app has little duplication (1.31% of the string memory), mostly the names of built-in classes that each realm stores.
