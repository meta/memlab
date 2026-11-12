---
title: memlab list
sidebar_label: list
custom_edit_url: null
---

List all test scenarios

```bash
memlab list 
```

## Example output

```text
$ memlab list
All available apps and interactions:

default-app-for-scenario:

test-spa: link-3
```

## How to read the output

`memlab list` prints the apps and interactions that ship with memlab's built-in test scenarios. These are used to test memlab itself. Your own scenarios are files passed with `--scenario`.

## Options

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
