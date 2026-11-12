`memlab warmup-and-snapshot` first warms up the web server like [`memlab warmup`](./warmup.md), then does the same as [`memlab snapshot`](./snapshot.md). The warm-up prints nothing, so the output is the same as `memlab snapshot`'s.

`page-load[765.2KB](baseline)[s1] > action-on-page[1.7MB](target)[s2] > revert[1.7MB](final)[s3]` lists the steps of the scenario in order. Each step shows its name, the JS heap size after the step, its role, and the heap snapshot taken there (`s1` is `data/cur/s1.heapsnapshot` in the work directory):

- `baseline`: after the page at `url` loads.
- `target`: after `action` runs (here, opening the settings dialog).
- `final`: after `back` runs (here, closing it).

`total time` is how long the browser run took.
