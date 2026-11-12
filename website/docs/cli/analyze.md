---
title: memlab analyze
sidebar_label: analyze
custom_edit_url: null
---

import TerminalOutput from '@site/src/components/TerminalOutput';
import analyze_output from '!!raw-loader!../_cli/output/analyze.txt';
import analyze_unbound_collection_output from '!!raw-loader!../_cli/output/analyze-unbound-collection.txt';
import analyze_collections_with_stale_output from '!!raw-loader!../_cli/output/analyze-collections-with-stale.txt';
import analyze_detached_DOM_output from '!!raw-loader!../_cli/output/analyze-detached-DOM.txt';
import analyze_global_variable_output from '!!raw-loader!../_cli/output/analyze-global-variable.txt';
import analyze_object_output from '!!raw-loader!../_cli/output/analyze-object.txt';
import analyze_object_fanout_output from '!!raw-loader!../_cli/output/analyze-object-fanout.txt';
import analyze_object_shallow_output from '!!raw-loader!../_cli/output/analyze-object-shallow.txt';
import analyze_shape_output from '!!raw-loader!../_cli/output/analyze-shape.txt';
import analyze_object_size_output from '!!raw-loader!../_cli/output/analyze-object-size.txt';
import analyze_unbound_object_output from '!!raw-loader!../_cli/output/analyze-unbound-object.txt';
import analyze_unbound_shape_output from '!!raw-loader!../_cli/output/analyze-unbound-shape.txt';
import analyze_string_output from '!!raw-loader!../_cli/output/analyze-string.txt';

Run heap analysis on heap snapshots.

```bash
memlab analyze <PLUGIN_NAME> [PLUGIN_OPTIONS]
```

## Example output

<TerminalOutput output={analyze_output} />

## How to read the output

Without a plugin name, `memlab analyze` lists the available analysis plugins and their options. Each plugin has its own section on this page, with an example of its output.

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

### Example output

<TerminalOutput output={analyze_unbound_collection_output} />

### How to read the output

`memlab analyze unbound-collection` compares a series of snapshots of the same page and lists the collections (`Map`, `Set`, and arrays) whose number of entries keeps growing.

Each line is the collection and its id, then its number of entries in each snapshot in order. Here the scenario opens and closes the settings dialog 4 times, taking a snapshot after each step. The `openedDialogs` `Set` gains one entry each time a dialog opens, and loses none when it closes. A collection that grows with every repetition of an action, and never shrinks, is a likely leak.

### Options

 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze collections-with-stale

Analyze collections holding stale objects

```bash
memlab analyze collections-with-stale 
```

### Example output

<TerminalOutput output={analyze_collections_with_stale_output} />

### How to read the output

`memlab analyze collections-with-stale` finds collections (arrays, `Map`s, `Set`s, and objects) that hold stale objects. Stale objects are detached DOM elements and unmounted React Fiber nodes, which the app no longer uses.

Each entry is the collection's id and retained size, how many of its elements are stale, and the ids of the stale elements. For a `Map` or `Set`, the collection is its internal table.

In this example, the collection is the internal table of the global `openedDialogs` `Set`, and the stale element is the `<div class="settings">` of the closed dialog. The app adds each dialog to the `Set` but never deletes it when the dialog closes.

### Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--output`**: specify output format of the analysis (available options: 'text', 'json'; defaults to 'text')

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze detached-DOM

Get detached DOM elements

```bash
memlab analyze detached-DOM 
```

### Example output

<TerminalOutput output={analyze_detached_DOM_output} />

### How to read the output

`memlab analyze detached-DOM` lists the DOM elements that were removed from the document but are still in memory, sorted by retained size. Elements retained by another element in the list are left out, so each subtree appears once.

Each line is `@id type name: N edges, retained size, refs: [...]`. `edges` is the number of references the object holds, and `refs` lists the names of the references that point to it (empty when they are all array indexes or DOM children).

In this example, the closed dialog's rows (`Detached <div>`) are still in memory, along with the browser's data for them (`blink::NodeRareData`, `blink::EventTargetData`). To find out what keeps them alive, pass an `@id` to [`memlab trace`](./trace.md).

### Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--output`**: specify output format of the analysis (available options: 'text', 'json'; defaults to 'text')

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze global-variable

Get global variables in heap

```bash
memlab analyze global-variable 
```

### Example output

<TerminalOutput output={analyze_global_variable_output} />

### How to read the output

`memlab analyze global-variable` lists the properties of the global objects (`window` in a browser), sorted by the memory they retain. memlab leaves out the standard `window` properties it knows about, but engine and browser internals still fill the top of the list.

Each line is `--property--> @id type name: N edges, retained size, refs: [...]`. Look for names that belong to your app: here `eventBus` retains 672 bytes, and following it with [`memlab analyze object`](#memlab-analyze-object) or [`memlab trace`](./trace.md) leads to the dialog that its listener keeps alive. `2137 more references...` counts the global properties that were not printed.

### Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--output`**: specify output format of the analysis (available options: 'text', 'json'; defaults to 'text')

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze object

Get properties inside an object

```bash
memlab analyze object 
```

### Example output

<TerminalOutput output={analyze_object_output} />

### How to read the output

`memlab analyze object` prints one object, its references, and its referrers.

- `shallow size` and `retained size` are in bytes. The retained size is the memory freed if nothing referenced the object. `dominator node` is the closest object that every path from a GC root to this object goes through.
- `REFERENCES` are the objects this one points to, with the property name on the arrow.
- `REFERRERS` are the objects that point to this one, with the property name on the arrow after them.

In this example, the `SettingsDialog` retains 806.6KB, almost all of it in its 800KB `history` array. Its referrers show what keeps it alive: a closure scope that holds it as `dialog` and `this` (the scope of the event bus listener) and a `WeakRef`, which does not keep it alive.

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

### Example output

<TerminalOutput output={analyze_object_fanout_output} />

### How to read the output

`memlab analyze object-fanout` lists the objects with the most outgoing references. A collection with a huge number of entries is often a cache or registry that never removes anything.

Each line is `@id type name: N edges, retained size, refs: [...]`, where `refs` lists the names of the references that point to the object. The top entries in a browser are usually engine and DOM metadata (`DescriptorArray`, `Window`, `Document`). Here the `Array` referenced as `labels`, with 243 edges, is the dialog's list of row labels.

### Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--output`**: specify output format of the analysis (available options: 'text', 'json'; defaults to 'text')

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze object-shallow

Get objects by key and value, without recursing into sub-objects

```bash
memlab analyze object-shallow 
```

### Example output

<TerminalOutput output={analyze_object_shallow_output} />

### How to read the output

`memlab analyze object-shallow` finds objects with the same class and the same top-level keys and values, without comparing nested objects. Duplicated objects are candidates for sharing one instance.

- `All objects` gives the number and size of the objects compared, and how much of it is duplicated.
- `Top duplicated objects in count` shows `[number of copies, total size]` and the object, serialized. References to other objects appear as `REFERENCE_<id>`.
- `Top duplicated objects in size` shows `[total size, number of copies]` and some `node examples` to look at with [`memlab analyze object`](#memlab-analyze-object).

This small app has almost no duplication (0.06% of the size). The duplicated objects are empty objects and DOM wrappers.

### Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze shape

List the shapes that retained most memory

```bash
memlab analyze shape 
```

### Example output

<TerminalOutput output={analyze_shape_output} />

### How to read the output

`memlab analyze shape` groups the objects by shape (their class and property names) and lists the shapes that retain the most memory in total.

- `Heap overall statistics` gives the memory held by React Fiber nodes and by `Error` objects.
- Each shape line gives its total retained size, the number of objects (`N`), and examples with their own retained size.
- The lines under a shape show its common referrers, as `[referrer] --reference-->: number of objects`.

In this example, the `SettingsDialog` shape and the closure scope (`system / Context`) that holds it both retain 806.6KB. That is the same memory, counted once per shape. The scope is referenced by `handleThemeChange`, the event bus listener that keeps the dialog alive.

### Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze object-size

Get the largest objects in heap

```bash
memlab analyze object-size 
```

### Example output

<TerminalOutput output={analyze_object_size_output} />

### How to read the output

`memlab analyze object-size` lists the objects with the largest retained size. Objects retained by a larger object in the list are left out, so each line is a separate chunk of memory.

Each line is `@id type name: N edges, retained size, refs: [...]`, where `refs` lists the names of the references that point to the object. Here the top entry is an 800KB `Array` referenced as `history`: the history array of a settings dialog that was closed but is still in memory.

### Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--output`**: specify output format of the analysis (available options: 'text', 'json'; defaults to 'text')

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze unbound-object

Check unbound object growth (a single object with growing retained size)

```bash
memlab analyze unbound-object 
```

### Example output

<TerminalOutput output={analyze_unbound_object_output} />

### How to read the output

`memlab analyze unbound-object` compares a series of snapshots of the same page and lists the objects whose retained size keeps growing.

Each line is the object and its id, then its retained size in each snapshot in order. In this example, the global object grows once, between the first and the second snapshot, and then stays flat. That is one-time setup, not a leak. A leak keeps growing with every repetition of the same action.

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

### Example output

<TerminalOutput output={analyze_unbound_shape_output} />

### How to read the output

`memlab analyze unbound-shape` compares a series of snapshots of the same page and lists the shapes (class and property names) whose total retained size keeps growing.

Each line is the shape, its number of objects and total retained size in each snapshot in order, and one example object id per snapshot. In this example, after the first time the dialog opens, strings grow by 240 every time it opens again: the dialog's row labels, which are still in memory after it closes.

### Options

 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.

## memlab analyze string

Find duplicated string instances in heap

```bash
memlab analyze string 
```

### Example output

<TerminalOutput output={analyze_string_output} />

### How to read the output

`memlab analyze string` finds strings that are stored more than once. Duplicated strings can be shared, for example by reusing one constant, to save memory.

- `All strings` gives the number and size of the strings, and how much of it is duplicated.
- `Top duplicated strings in count` shows `[number of copies, total size]` and the string.
- `Top duplicated strings in size` shows `[total size, number of copies]` and some `node examples` to look at with [`memlab trace`](./trace.md).

This small app has little duplication (1.31% of the string memory), mostly the names of built-in classes that each realm stores.

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
