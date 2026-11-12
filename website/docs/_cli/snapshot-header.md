`memlab snapshot-header` reads only the header of a snapshot file, so it is instant even for files of several GB. Use it to check a snapshot before analyzing it.

- `nodes` and `edges` are the number of objects and references in the snapshot.
- `allocation stacks` tells whether the snapshot recorded where each object was allocated.
- `detachedness` tells whether the browser marked detached DOM elements. memlab's leak detection uses this.
- `Memory needed to analyze it` estimates the JS heap memlab needs to load the snapshot, compared with what the current Node.js process can use. If the estimate is larger, pass a larger `--max-old-space-size` to Node.js.
