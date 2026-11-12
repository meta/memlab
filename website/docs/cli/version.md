---
title: memlab version
sidebar_label: version
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import version_output from '!!raw-loader!../_cli/output/version.txt';

Show the versions of all memlab packages installed

```bash
memlab version 
```

## Example output

<TerminalOutput output={version_output} />

## How to read the output

`memlab version` prints the version of each memlab package that the CLI loads. When reporting a problem, include this output.

## Options

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
