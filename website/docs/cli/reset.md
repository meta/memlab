---
title: memlab reset
sidebar_label: reset
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import reset_output from '!!raw-loader!../_cli/output/reset.txt';

Reset and initialize all directories

```bash
memlab reset 
```

## Example output

<TerminalOutput output={reset_output} />

## How to read the output

`memlab reset` deletes the snapshots and results in the work directory and creates it again empty. It prints nothing when it succeeds.

## Options

 * **`--work-dir`**: set the working directory of the current run

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
