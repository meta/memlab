---
title: memlab analyze
sidebar_label: analyze
custom_edit_url: null
---

Run heap analysis on heap snapshots.

```bash
memlab analyze <PLUGIN_NAME> [PLUGIN_OPTIONS]
```

## Options

 * **`--analysis-plugin`**: specify the external heap analysis plugin file (must be a vanilla JS file ended with `Analysis.js` suffix)
 * **`--heap-parser-dict-fast-store-size`**: the size threshold for switching from fast store to slower store in the heap snapshot parser. The default value is 5,000,000. If you get the `FATAL ERROR: invalid table size Allocation failed - JavaScript heap out of memory` error, try to decrease the threshold here
 * **`--work-dir`**: set the working directory of the current run

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze unbound-collection

Check unbound collection growth (e.g., Map with growing number of entries)

```bash
memlab analyze unbound-collection 
```

### Options

 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze collections-with-stale

Analyze collections holding stale objects

```bash
memlab analyze collections-with-stale 
```

### Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--output`**: specify output format of the analysis (available options: 'text', 'json'; defaults to 'text')

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze detached-DOM

Get detached DOM elements

```bash
memlab analyze detached-DOM 
```

### Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--output`**: specify output format of the analysis (available options: 'text', 'json'; defaults to 'text')

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze global-variable

Get global variables in heap

```bash
memlab analyze global-variable 
```

### Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--output`**: specify output format of the analysis (available options: 'text', 'json'; defaults to 'text')

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze object

Get properties inside an object

```bash
memlab analyze object 
```

### Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--node-id`**: set heap node ID
 * **`--output`**: specify output format of the analysis (available options: 'text', 'json'; defaults to 'text')

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze object-fanout

Get objects with the most out-going references in heap

```bash
memlab analyze object-fanout 
```

### Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--output`**: specify output format of the analysis (available options: 'text', 'json'; defaults to 'text')

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze object-shallow

Get objects by key and value, without recursing into sub-objects

```bash
memlab analyze object-shallow 
```

### Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze shape

List the shapes that retained most memory

```bash
memlab analyze shape 
```

### Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze object-size

Get the largest objects in heap

```bash
memlab analyze object-size 
```

### Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--output`**: specify output format of the analysis (available options: 'text', 'json'; defaults to 'text')

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze unbound-object

Check unbound object growth (a single object with growing retained size)

```bash
memlab analyze unbound-object 
```

### Options

 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze react-hooks

Show a memory breakdown of the most memory-consuming React components and their React hooks. This works best with unminified heap snapshots taken from React apps running in Dev mode. But also supports minified heap snapshots taken from React apps in production mode.

```bash
memlab analyze react-hooks 
```

### Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze unbound-shape

Get shapes with unbound growth (a class of objects with growing aggregated retained size)

```bash
memlab analyze unbound-shape 
```

### Options

 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze string

Find duplicated string instances in heap

```bash
memlab analyze string 
```

### Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze unmounted-fiber-node

Get unmounted React Fiber nodes

```bash
memlab analyze unmounted-fiber-node 
```

### Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--output`**: specify output format of the analysis (available options: 'text', 'json'; defaults to 'text')

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
