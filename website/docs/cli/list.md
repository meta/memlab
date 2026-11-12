---
title: memlab list
sidebar_label: list
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import list_output from '!!raw-loader!../_cli/output/list.txt';

List all test scenarios

```bash
memlab list 
```

## Example output

<TerminalOutput output={list_output} />

## How to read the output

`memlab list` prints the apps and interactions that ship with memlab's built-in test scenarios. These are used to test memlab itself. Your own scenarios are files passed with `--scenario`.

## Options

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
