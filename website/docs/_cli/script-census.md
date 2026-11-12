`memlab script-census` lists the scripts whose source text is kept in memory, grouped by URL (or by the beginning of the source for scripts without one).

- `scripts` is the number of script objects, and `copies` is the number of distinct copies of the source text.
- `source` is the size of the source text kept.
- `extra copies` is the memory spent on duplicate copies of the same source. A large value usually means the same bundle is loaded more than once, for example in several iframes.

This small app keeps 14.0 KB of source: its own page (`http://localhost:3000/`) and helper scripts injected by the browser automation.
