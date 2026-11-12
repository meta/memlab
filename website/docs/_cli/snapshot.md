`memlab snapshot` runs the scenario and saves the heap snapshots without looking for leaks.

`page-load[765.2KB](baseline)[s1] > action-on-page[1.7MB](target)[s2] > revert[1.7MB](final)[s3]` lists the steps of the scenario in order. Each step shows its name, the JS heap size after the step, its role, and the heap snapshot taken there (`s1` is `data/cur/s1.heapsnapshot` in the work directory):

- `baseline`: after the page at `url` loads.
- `target`: after `action` runs (here, opening the settings dialog).
- `final`: after `back` runs (here, closing it).

`total time` is how long the browser run took.

To look for leaks in these snapshots later, use [`memlab find-leaks`](./find-leaks.md) with the same `--work-dir`. To look at one snapshot, pass it to any heap command, e.g. [`memlab heap-stats`](./heap-stats.md) `--snapshot <work-dir>/data/cur/s3.heapsnapshot`.
