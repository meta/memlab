---
title: memlab help
sidebar_label: help
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import help_output from '!!raw-loader!../_cli/output/help.txt';

List all MemLab CLI commands or print helper text for a specific command

```bash
memlab help <COMMAND> [SUB-COMMANDS]
```

## Example output

<TerminalOutput output={help_output} />

## How to read the output

`memlab help <command>` prints the full description of a command and all its options, the same text as on that command's page. `memlab help` without a command lists all commands.

## Options

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
