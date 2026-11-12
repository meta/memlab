`memlab measure` runs the scenario `--run-num` times to show how much the memory varies from run to run. Each run prints its own line of steps.

`page-load[765.2KB](baseline)[s1] > action-on-page[1.7MB](target)[s2] > revert[1.7MB](final)[s3]` lists the steps of the scenario in order. Each step shows its name, the JS heap size after the step, its role, and the heap snapshot taken there (`s1` is `data/cur/s1.heapsnapshot` in the work directory):

- `baseline`: after the page at `url` loads.
- `target`: after `action` runs (here, opening the settings dialog).
- `final`: after `back` runs (here, closing it).

`total time` is how long the browser run took.

Here both runs report the same sizes, so a difference of a few hundred KB between two versions of this app would be real, not noise. For apps whose heap varies more between runs, use more runs.
