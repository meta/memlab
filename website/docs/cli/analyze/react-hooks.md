---
title: memlab analyze react-hooks
sidebar_label: react-hooks
custom_edit_url: null
---

Show a memory breakdown of the most memory-consuming React components and their React hooks. This works best with unminified heap snapshots taken from React apps running in Dev mode. But also supports minified heap snapshots taken from React apps in production mode.

```bash
memlab analyze react-hooks 
```

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis

The [universal options](../CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
