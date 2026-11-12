`memlab heap-stats` breaks down the memory in one snapshot.

The first table splits the total by where the memory lives:
- `V8 heap` is what the JavaScript engine manages, split into code, strings, JS arrays (including the storage behind arrays and object elements), system objects, and everything else.
- `native` is memory held outside the JavaScript heap, such as DOM nodes and the data behind typed arrays.

The second table splits the same total by why the memory exists: the source text of scripts, compiled code and function metadata, and objects the program allocated.

In this example, `JS arrays` is 37.3% of the heap, which is unusual for a page this small. The leaked dialog keeps an 800KB `history` array, and [`memlab class-histogram`](./class-histogram.md) and [`memlab analyze object-size`](./analyze.md#memlab-analyze-object-size) point to it.
