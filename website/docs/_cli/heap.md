`memlab heap` loads a snapshot and opens a prompt where you can run commands against it without loading it again. That is faster than separate commands for large snapshots.

In this example, `trace --node-id` prints the retainer trace of a `SettingsDialog`, read the same way as with [`memlab trace`](./trace.md). The prompt supports `trace`, `analyze`, and `help`, with the same options as the CLI commands of the same name, minus `--snapshot`. Type `exit` or press Ctrl+C twice to leave.
