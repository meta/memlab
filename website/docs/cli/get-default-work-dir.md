---
title: memlab get-default-work-dir
sidebar_label: get-default-work-dir
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import get_default_work_dir_output from '!!raw-loader!../_cli/output/get-default-work-dir.txt';

Query the default working directory

```bash
memlab get-default-work-dir 
```

## Example output

<TerminalOutput output={get_default_work_dir_output} />

## How to read the output

`memlab get-default-work-dir` prints the work directory that commands use when `--work-dir` is not given. That is where `memlab run` saves its snapshots and results.

## Options

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
