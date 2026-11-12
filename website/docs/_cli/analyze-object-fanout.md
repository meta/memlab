`memlab analyze object-fanout` lists the objects with the most outgoing references. A collection with a huge number of entries is often a cache or registry that never removes anything.

Each line is `@id type name: N edges, retained size, refs: [...]`, where `refs` lists the names of the references that point to the object. The top entries in a browser are usually engine and DOM metadata (`DescriptorArray`, `Window`, `Document`). Here the `Array` referenced as `labels`, with 243 edges, is the dialog's list of row labels.
