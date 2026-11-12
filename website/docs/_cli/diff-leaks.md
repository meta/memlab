`memlab diff-leaks` finds the leaks of the treatment run that the control run does not have. Here the control run used the fixed version of the app, and the treatment run used the version that leaks.

- The **memory chart** shows the JS heap size in MB after each step of the control run (bars 1 to 3), then a gap (4 to 6), then each step of the treatment run (7 to 9). In the control run, the heap goes back down when the dialog closes (bar 3). In the treatment run, it stays up (bar 9).
- `[0] traces from control group` and `[386] traces from treatment group` count the leaked objects found in each run (one number per work directory).
- `MemLab found 1 new leak(s) in the treatment group` counts the leaks left after removing every leak whose trace also appears in the control run. The trace below it reads the same way as in [`memlab find-leaks`](./find-leaks.md).

The fixed app has no leak, so the treatment's leak is reported as new. That makes `diff-leaks` useful for checking a change: if the change adds a leak, it shows up here.
