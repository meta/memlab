`memlab find-objects` lists the objects whose name matches `--name-pattern` (a regular expression), sorted by retained size.

- `type` tells objects, closures, and strings apart. Here the `object` is a `SettingsDialog` instance, the `closure` is the `SettingsDialog` class itself, and the `string` is the text `"SettingsDialog"`.
- `retained size` is the memory that would be freed if the object were no longer referenced.
- `detached` marks detached DOM elements.

The last line is the command that shows why the top object is still alive. A `SettingsDialog` instance retaining 787.7 KB after every dialog was closed is worth tracing.
