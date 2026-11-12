---
title: memlab analyze
sidebar_label: analyze
custom_edit_url: null
---

Run heap analysis on heap snapshots.

```bash
memlab analyze <PLUGIN_NAME> [PLUGIN_OPTIONS]
```

## Example output

```text
$ memlab analyze

  Heap analysis plugin name missing

  memlab analyze <PLUGIN_NAME> [PLUGIN_OPTIONS]
  Run heap analysis on heap snapshots.
  Options: --analysis-plugin --heap-parser-dict-fast-store-size
           --work-dir

   memlab analyze unbound-collection
   Check unbound collection growth (e.g., Map with growing number of entries)
   Options: --snapshot-dir

   memlab analyze collections-with-stale
   Analyze collections holding stale objects
   Options: --snapshot --output

   memlab analyze detached-DOM
   Get detached DOM elements
   Options: --snapshot --output

   memlab analyze global-variable
   Get global variables in heap
   Options: --snapshot --output

   memlab analyze object
   Get properties inside an object
   Options: --snapshot --node-id --output

   memlab analyze object-fanout
   Get objects with the most out-going references in heap
   Options: --snapshot --output

   memlab analyze object-shallow
   Get objects by key and value, without recursing into sub-objects
   Options: --snapshot

   memlab analyze shape
   List the shapes that retained most memory
   Options: --snapshot

   memlab analyze object-size
   Get the largest objects in heap
   Options: --snapshot --output

   memlab analyze unbound-object
   Check unbound object growth (a single object with growing retained size)
   Options: --snapshot-dir

   memlab analyze react-hooks
   Show a memory breakdown of the most memory-consuming React components and their React hooks. This works best with
   unminified heap snapshots taken from React apps running in Dev mode. But also supports minified heap snapshots taken
   from React apps in production mode.
   Options: --snapshot

   memlab analyze unbound-shape
   Get shapes with unbound growth (a class of objects with growing aggregated retained size)
   Options: --snapshot-dir

   memlab analyze string
   Find duplicated string instances in heap
   Options: --snapshot

   memlab analyze unmounted-fiber-node
   Get unmounted React Fiber nodes
   Options: --snapshot --output
```

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

```text
$ memlab analyze unbound-collection --snapshot-dir /tmp/memlab-example/series/data/cur
Top growing objects in sizes:
 (Use `memlab trace --node-id=@ID` to get trace)

· Set [object](@47967):  1 > 2 > 2 > 3 > 3 > 4 > 4 > 5 > 5
```

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

```text
$ memlab analyze collections-with-stale --snapshot /tmp/memlab-example/leak/data/cur/s3.heapsnapshot

Collections holding stale objects:

·  (@50805) 60 bytes (1 out of 2 elements are stale):
  @65915
```

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

```text
$ memlab analyze detached-DOM --snapshot /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
· @71941 native Detached <div>: 10 edges, 264 bytes, refs: []
· @15826 native Detached blink::NodeRareData: 3 edges, 232 bytes, refs: []
· @7932 native Detached blink::EventTargetData: 1 edges, 196 bytes, refs: []
· @71887 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71889 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71891 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71893 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71895 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71897 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71899 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71901 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71903 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71905 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71907 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71909 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71911 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71913 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71915 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71917 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71919 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71921 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71923 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71925 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71927 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71929 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71931 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71933 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71935 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71937 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71939 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71943 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71945 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71947 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71949 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71951 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71953 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71955 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71957 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71959 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71961 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71963 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71965 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71967 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71969 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71971 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71973 native Detached <div>: 9 edges, 184 bytes, refs: []
· @71975 native Detached <div>: 9 edges, 184 bytes, refs: []
```

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

```text
$ memlab analyze global-variable --snapshot /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
·  --native_context--> @7597 native system / NativeContext / http://localhost:3000: 267 edges, 59.5KB, refs: [value, native_context, 120 / extensions::ScriptContext::v8_context_, 118 / gin::ContextHolder::context_, 117 / V8PerContextData::context_, constructor, getCoalescedEvents, getPredictedEvents, __proto__, prototype]
·  --native_context--> @7795 native system / NativeContext / http://localhost:3000: 265 edges, 57.8KB, refs: [value, native_context, 301 / extensions::ScriptContext::v8_context_, 300 / gin::ContextHolder::context_, 299 / V8PerContextData::context_, constructor, csi, loadTimes, setter, getter]
·  --global_object--> @40065 Window [JSGlobalObject] / http://localhost:3000: 673 edges, 49.4KB, refs: [prototype, global_object]
·  --global_object--> @33803 Window [JSGlobalObject] / http://localhost:3000: 670 edges, 46.1KB, refs: [prototype, global_object]
·  --5--> @53469 native HTMLDocument: 60 edges, 22.5KB, refs: [value, <symbol Window#DocumentCachedAccessor>, cppgc_object, 114 / DevTools console]
·  --<symbol Window#DocumentCachedAccessor>--> @53469 native HTMLDocument: 60 edges, 22.5KB, refs: [value, <symbol Window#DocumentCachedAccessor>, cppgc_object, 114 / DevTools console]
·  --map--> @32599 object shape system / Map: 18 edges, 10KB, refs: [map]
·  --map--> @46587 object shape system / Map: 18 edges, 10KB, refs: [map]
·  --21--> @804 native blink::LocalFrame: 29 edges, 9.1KB, refs: []
·  --25--> @33471 native Window / http://localhost:3000: 36 edges, 7.6KB, refs: [value, cppgc_object, global_proxy, <symbol V8PrivateProperty::CachedAccessor::kWindowProxy>, globalThis, this, global_proxy_object]
·  --26--> @33471 native Window / http://localhost:3000: 36 edges, 7.6KB, refs: [value, cppgc_object, global_proxy, <symbol V8PrivateProperty::CachedAccessor::kWindowProxy>, globalThis, this, global_proxy_object]
·  --<symbol V8PrivateProperty::CachedAccessor::kWindowProxy>--> @33471 native Window / http://localhost:3000: 36 edges, 7.6KB, refs: [value, cppgc_object, global_proxy, <symbol V8PrivateProperty::CachedAccessor::kWindowProxy>, globalThis, this, global_proxy_object]
·  --global_proxy--> @33471 native Window / http://localhost:3000: 36 edges, 7.6KB, refs: [value, cppgc_object, global_proxy, <symbol V8PrivateProperty::CachedAccessor::kWindowProxy>, globalThis, this, global_proxy_object]
·  --1--> @33471 native Window / http://localhost:3000: 36 edges, 7.6KB, refs: [value, cppgc_object, global_proxy, <symbol V8PrivateProperty::CachedAccessor::kWindowProxy>, globalThis, this, global_proxy_object]
·  --cppgc_object--> @33471 native Window / http://localhost:3000: 36 edges, 7.6KB, refs: [value, cppgc_object, global_proxy, <symbol V8PrivateProperty::CachedAccessor::kWindowProxy>, globalThis, this, global_proxy_object]
·  --cppgc_object--> @33471 native Window / http://localhost:3000: 36 edges, 7.6KB, refs: [value, cppgc_object, global_proxy, <symbol V8PrivateProperty::CachedAccessor::kWindowProxy>, globalThis, this, global_proxy_object]
·  --20--> @6432 native blink::SoftNavigationHeuristics: 3 edges, 4.5KB, refs: []
·  --35--> @6442 native blink::HeapHashTableBacking<blink::HashTable<const char *, blink::KeyValuePair<const char *, cppgc::internal::BasicMember<blink::Supplement<blink::LocalDOMWindow>, cppgc::internal::StrongMemberTag, cppgc::internal::DijkstraWriteBarrierPolicy>>, blink::KeyValuePairExtractor, blink::HashMapValueTraits<blink::HashTraits<const char *>, blink::HashTraits<cppgc::internal::BasicMember<blink::Supplement<blink::LocalDOMWindow>, cppgc::internal::StrongMemberTag, cppgc::internal::DijkstraWriteBarrierPolicy>>>, blink::HashTraits<const char *>, blink::HeapAllocator>>: 10 edges, 1.8KB, refs: []
·  --33--> @6438 native blink::HeapHashTableBacking<blink::HashTable<cppgc::internal::BasicMember<blink::ContextLifecycleObserver, cppgc::internal::WeakMemberTag, cppgc::internal::DijkstraWriteBarrierPolicy>, blink::KeyValuePair<cppgc::internal::BasicMember<blink::ContextLifecycleObserver, cppgc::internal::WeakMemberTag, cppgc::internal::DijkstraWriteBarrierPolicy>, unsigned int>, blink::KeyValuePairExtractor, blink::HashMapValueTraits<blink::HashTraits<cppgc::internal::BasicMember<blink::ContextLifecycleObserver, cppgc::internal::WeakMemberTag, cppgc::internal::DijkstraWriteBarrierPolicy>>, blink::HashTraits<unsigned int>>, blink::HashTraits<cppgc::internal::BasicMember<blink::ContextLifecycleObserver, cppgc::internal::WeakMemberTag, cppgc::internal::DijkstraWriteBarrierPolicy>>, blink::HeapAllocator>>: 0 edges, 1KB, refs: []
·  --8--> @6422 native Navigator: 3 edges, 928 bytes, refs: []
·  --eventBus--> @47965 Object { listeners, on }: 4 edges, 672 bytes, refs: [this, value, eventBus]
·  --AsyncDisposableStack--> @52581 closure AsyncDisposableStack: 10 edges, 640 bytes, refs: [constructor, value, AsyncDisposableStack, js_async_disposable_stack_function]
·  --DisposableStack--> @52579 closure DisposableStack: 10 edges, 640 bytes, refs: [constructor, value, DisposableStack, js_disposable_stack_function]
·  --AsyncDisposableStack--> @40285 closure AsyncDisposableStack: 10 edges, 640 bytes, refs: [constructor, value, AsyncDisposableStack, js_async_disposable_stack_function]
·  --DisposableStack--> @40283 closure DisposableStack: 10 edges, 640 bytes, refs: [constructor, value, DisposableStack, js_disposable_stack_function]
·  --34--> @6440 native blink::HeapHashTableBacking<blink::HashTable<const char *, blink::KeyValuePair<const char *, cppgc::internal::BasicMember<blink::Supplement<blink::ExecutionContext>, cppgc::internal::StrongMemberTag, cppgc::internal::DijkstraWriteBarrierPolicy>>, blink::KeyValuePairExtractor, blink::HashMapValueTraits<blink::HashTraits<const char *>, blink::HashTraits<cppgc::internal::BasicMember<blink::Supplement<blink::ExecutionContext>, cppgc::internal::StrongMemberTag, cppgc::internal::DijkstraWriteBarrierPolicy>>>, blink::HashTraits<const char *>, blink::HeapAllocator>>: 2 edges, 600 bytes, refs: []
·  --SuppressedError--> @52679 closure SuppressedError: 10 edges, 560 bytes, refs: [constructor, value, SuppressedError, suppressed_error_function]
·  --SuppressedError--> @40521 closure SuppressedError: 10 edges, 560 bytes, refs: [constructor, value, SuppressedError, suppressed_error_function]
·  --Iterator--> @33163 closure Iterator: 14 edges, 512 bytes, refs: [constructor, value, Iterator, iterator_function, initial_iterator_function]
·  --Iterator--> @40197 closure Iterator: 14 edges, 512 bytes, refs: [constructor, value, Iterator, iterator_function, initial_iterator_function]
·  --10--> @6426 native Navigation: 3 edges, 400 bytes, refs: []
·  --puppeteer___ariaQuerySelectorAll--> @64393 closure : 8 edges, 348 bytes, refs: [value, puppeteer___ariaQuerySelectorAll, constructor]
·  --puppeteer___ariaQuerySelector--> @64299 closure : 8 edges, 348 bytes, refs: [puppeteer___ariaQuerySelector, constructor, value]
·  --9--> @6424 native CustomElementRegistry: 3 edges, 344 bytes, refs: []
·  --15--> @934 native blink::SpellChecker: 4 edges, 280 bytes, refs: []
·  --map--> @52695 object shape system / Map: 18 edges, 280 bytes, refs: [map]
·  --map--> @40545 object shape system / Map: 18 edges, 280 bytes, refs: [map]
·  --22--> @932 native blink::LocalWindowProxyManager: 3 edges, 256 bytes, refs: []
·  --27--> @6420 native blink::WindowAgent: 1 edges, 232 bytes, refs: []
·  --Float16Array--> @52475 closure Float16Array: 11 edges, 208 bytes, refs: [constructor, value, Float16Array, float16_array_fun]
·  --Float16Array--> @40109 closure Float16Array: 11 edges, 208 bytes, refs: [constructor, value, Float16Array, float16_array_fun]
·  --32--> @6436 native blink::HeapVectorBacking<cppgc::internal::BasicMember<blink::ContextLifecycleObserver, cppgc::internal::UntracedMemberTag, cppgc::internal::NoWriteBarrierPolicy>>: 0 edges, 192 bytes, refs: []
·  --properties--> @32947 native system / PropertyArray: 41 edges, 168 bytes, refs: [properties]
·  --29--> @6434 native blink::OriginTrialContext: 1 edges, 168 bytes, refs: []
·  --properties--> @46591 native system / PropertyArray: 41 edges, 168 bytes, refs: [properties]
·  --14--> @6430 native blink::InputMethodController: 2 edges, 152 bytes, refs: []
·  --30--> @6418 native blink::ContentSecurityPolicy: 1 edges, 152 bytes, refs: []
·  --map--> @52699 object shape system / Map: 16 edges, 144 bytes, refs: [map]
·  --31--> @4962 native blink::RuntimeFeatureStateOverrideContext: 3 edges, 144 bytes, refs: []
·  --map--> @40551 object shape system / Map: 16 edges, 144 bytes, refs: [map]
2137 more references...
```

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

```text
$ memlab analyze object --snapshot /tmp/memlab-example/leak/data/cur/s3.heapsnapshot --node-id @71391
Heap node (object) @71391
 name: SettingsDialog
 # of references: 6
 # of referrers: 3
 shallow size: 60
 retained size: 806616
 dominator node: @71399

REFERENCES:
·  --container--> @65915 native Detached <div class="settings">: 7 edges, 45.3KB, refs: [container]
·  --labels--> @71393 Array: 243 edges, 6.2KB, refs: [labels]
·  --history--> @71395 Array: 3 edges, 800KB, refs: [history]
·  --unsubscribe--> @71397 closure : 6 edges, 52 bytes, refs: [unsubscribe]
·  --__proto__--> @50821 Object { close, constructor, open }: 6 edges, 799 bytes, refs: [__proto__, prototype]
·  --map--> @71039 object shape system / Map: 15 edges, 224 bytes, refs: [map, transition]

REFERRERS:
·  @71399 system / Context / scope @65777: 5 edges, 806.6KB, refs: [listener] --dialog-->
·  @71399 system / Context / scope @65777: 5 edges, 806.6KB, refs: [listener] --this-->
·  @65917 WeakRef: 3 edges, 16 bytes, refs: [] --target-->
```

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

```text
$ memlab analyze object-fanout --snapshot /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
· @32601 object shape system / DescriptorArray: 1620 edges, 9.9KB, refs: [descriptors]
· @46589 object shape system / DescriptorArray: 1620 edges, 9.9KB, refs: [descriptors]
· @40065 Window [JSGlobalObject] / http://localhost:3000: 673 edges, 49.4KB, refs: [prototype, global_object]
· @33803 Window [JSGlobalObject] / http://localhost:3000: 670 edges, 46.1KB, refs: [prototype, global_object]
· @65097 Document: 576 edges, 8.6KB, refs: [prototype, __proto__]
· @52945 Document: 576 edges, 5.8KB, refs: [prototype, __proto__]
· @32151 Window (prototype) / http://localhost:3000: 535 edges, 26.7KB, refs: [__proto__, prototype]
· @46239 Window (prototype) / http://localhost:3000: 535 edges, 26.7KB, refs: [prototype, __proto__]
· @32945 Window (internal cache) / http://localhost:3000: 534 edges, 10.2KB, refs: []
· @46141 Window (internal cache) / http://localhost:3000: 534 edges, 10.2KB, refs: []
· @71055 object shape system / DescriptorArray: 441 edges, 3KB, refs: [descriptors]
· @50117 HTMLElement: 412 edges, 3.5KB, refs: [prototype, __proto__]
· @69421 HTMLElement: 412 edges, 4.8KB, refs: [__proto__, prototype]
· @49255 Element: 342 edges, 3.9KB, refs: [prototype, __proto__]
· @68575 Element: 342 edges, 7.6KB, refs: [__proto__, prototype]
· @70271 SVGElement: 341 edges, 4.5KB, refs: [prototype]
· @70999 object shape system / DescriptorArray: 283 edges, 1.7KB, refs: [descriptors]
· @71005 object shape system / DescriptorArray: 271 edges, 2.1KB, refs: [descriptors]
· @71393 Array: 243 edges, 6.2KB, refs: [labels]
· @34149 Object [JSGlobalObject]: 71 edges, 6.5KB, refs: [prototype, global_object, security_token]
```

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

```text
$ memlab analyze object-shallow --snapshot /tmp/memlab-example/leak/data/cur/s3.heapsnapshot

All objects
·Count: 381 (4.46% are duplicated)
·Size: 998.4KB (0.06% are duplicated)

Top duplicated objects in count
 ·[7, 452 bytes]: "{"class":"Object","object":{}}"
 ·[6, 96 bytes]: "{"class":"Object (internal cache) / http://localhost:3000","object":{}}"
 ·[4, 64 bytes]: "{"class":"HTMLButtonElement","object":{}}"
 ·[2, 32 bytes]: "{"class":"HTMLDocument","object":{"location":"REFERENCE_65103","get location":"REFERENCE_52307","..."
 ·[2, 32 bytes]: "{"class":"HTMLButtonElement (internal cache) / http://localhost:3000","object":{}}"
 ·[2, 32 bytes]: "{"class":"HTMLHtmlElement","object":{}}"

Top duplicated objects in size:

 ·[452 bytes, 7]: "{"class":"Object","object":{}}"
    node examples: @34041, @34101, @34107, @35759, @40755, @41277, @44975

 ·[96 bytes, 6]: "{"class":"Object (internal cache) / http://localhost:3000","object":{}}"
    node examples: @46145, @46149, @46153, @50679, @50733, @50745

 ·[64 bytes, 4]: "{"class":"HTMLButtonElement","object":{}}"
    node examples: @50843, @80083, @71353, @71355

 ·[32 bytes, 2]: "{"class":"HTMLDocument","object":{"location":"REFERENCE_65103","get location":"REFERENCE_52307","..."
    node examples: @57463, @71087

 ·[32 bytes, 2]: "{"class":"HTMLButtonElement (internal cache) / http://localhost:3000","object":{}}"
    node examples: @65623, @50841

 ·[32 bytes, 2]: "{"class":"HTMLHtmlElement","object":{}}"
    node examples: @71377, @71379
```

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

```text
$ memlab analyze shape --snapshot /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
Heap overall statistics:
  Fiber node size: 0 byte
  Regular fiber node size: 0 byte
  Detached fiber node size: 0 byte
  Alternate fiber node size: 0 byte
  Error: 7.1KB
Object shapes with top retained sizes:
 (Use `memlab trace --node-id=@ID` to get trace)

· Array: 811.6KB (N: 8, Examples: @71395 [800KB] | @71393 [6.2KB] | @7525 [1.6KB] | @7713 [1.6KB] | @7909 [1.6KB])
  · [system / NativeContext / http://localhost:3000] --initial_array_prototype-->: 2
  · [(Global handles)] --259-->: 1
  · [(Global handles)] --73-->: 1
  · [(Global handles)] --180-->: 1

· system / Context / scope @65777: 806.6KB (N: 1, Examples: @71399 [806.6KB])
  · [handleThemeChange] --context-->: 1
  · [<closure>] --context-->: 1

· SettingsDialog: 806.6KB (N: 1, Examples: @71391 [806.6KB])
  · [system / Context / scope --dialog-->: 1
  · [system / Context / scope --this-->: 1

· Window [JSGlobalObject] / http://localhost:3000: 95.5KB (N: 2, Examples: @40065 [49.4KB] | @33803 [46.1KB])
  · [system / NativeContext / http://localhost:3000] --global_object-->: 2
  · [Window / http://localhost:3000] --global_object-->: 1
  · [Window [JSGlobalProxy] / http://localhost:3000] --global_object-->: 1

· string: 58.7KB (N: 7162, Examples: @65837 [9.7KB] | @47971 [6.9KB] | @17139 [2.7KB] | @64283 [1.7KB] | @14801 [120 bytes])
  · [system / FunctionTemplateInfo] --<numeric-element>-->: 6413
  · [system / ArrayList] --<numeric-element>-->: 2070
  · [system / AccessorInfo] --name-->: 1987
  · [system / Map] --elements_kind_name-->: 1437

· Window (prototype) / http://localhost:3000: 53.7KB (N: 4, Examples: @32151 [26.7KB] | @46239 [26.7KB] | @32171 [172 bytes] | @40547 [172 bytes])

· Object { ariaQuerySelector, ariaQuerySelectorAll, customQuerySelectors, pierceQuerySelector, pierceQuerySelectorAll, ... }: 29.9KB (N: 1, Examples: @57465 [29.9KB])
  · [system / Context / scope --he-->: 1
  · [(Global handles)] --116 / DevTools console-->: 1

· Window (internal cache) / http://localhost:3000: 20.5KB (N: 4, Examples: @32945 [10.2KB] | @46141 [10.2KB] | @32597 [72 bytes] | @46139 [72 bytes])

· Document: 14.5KB (N: 2, Examples: @65097 [8.6KB] | @52945 [5.8KB])

· Element: 11.6KB (N: 2, Examples: @68575 [7.6KB] | @49255 [3.9KB])

· HTMLElement: 8.3KB (N: 2, Examples: @69421 [4.8KB] | @50117 [3.5KB])

· system / Context / scope @66489: 7KB (N: 1, Examples: @71101 [7KB])
  · [system / Context / scope --previous-->: 10
  · [<closure>] --context-->: 1
  · [W] --context-->: 1
  · [fe] --context-->: 1

· Object [JSGlobalObject]: 6.5KB (N: 1, Examples: @34149 [6.5KB])
  · [Object [JSGlobalProxy]] --global_object-->: 1

· Object { constructor, toDateString, toISOString, toString, toTimeString, ... }: 6.5KB (N: 3, Examples: @7393 [2.1KB] | @7533 [2.1KB] | @7721 [2.1KB])
  · [(Global handles)] --3-->: 1
  · [(Global handles)] --267-->: 1
  · [(Global handles)] --81-->: 1
  · [(Global handles)] --188-->: 1

· Error: 6KB (N: 37, Examples: @67487 [296 bytes] | @33699 [160 bytes] | @33739 [160 bytes] | @33771 [160 bytes] | @33959 [160 bytes])

· TypedArray: 5.8KB (N: 36, Examples: @36747 [328 bytes] | @44193 [328 bytes] | @55697 [328 bytes] | @35119 [148 bytes] | @35353 [148 bytes])

· Math: 5.5KB (N: 3, Examples: @34799 [1.8KB] | @40873 [1.8KB] | @53461 [1.8KB])
  · [Window [JSGlobalObject] / http://localhost:3000] --Math-->: 2
  · [Object [JSGlobalObject]] --Math-->: 1

· Object { buffer, byteLength, constructor, get buffer, get byteLength, ... }: 5.2KB (N: 3, Examples: @34561 [1.7KB] | @40467 [1.7KB] | @52629 [1.7KB])
  · [system / NativeContext / http://localhost:3000] --typed_array_prototype-->: 2

· console: 4.8KB (N: 3, Examples: @41139 [1.8KB] | @53467 [1.8KB] | @34785 [1.2KB])
  · [system / PropertyArray] --<numeric-element>-->: 3
  · [Object] --console-->: 3
  · [Window [JSGlobalObject] / http://localhost:3000] --console-->: 2
  · [Object [JSGlobalObject]] --console-->: 1

· SVGElement: 4.5KB (N: 1, Examples: @70271 [4.5KB])

· String: 4.2KB (N: 3, Examples: @7527 [1.4KB] | @7715 [1.4KB] | @7911 [1.4KB])
  · [system / NativeContext / http://localhost:3000] --initial_string_prototype-->: 2
  · [(Global handles)] --261-->: 1
  · [(Global handles)] --75-->: 1
  · [(Global handles)] --182-->: 1

· DataView: 3.8KB (N: 3, Examples: @33357 [1.2KB] | @36887 [1.2KB] | @44549 [1.2KB])

· Intl.Locale: 3.6KB (N: 3, Examples: @36321 [1.2KB] | @45499 [1.2KB] | @56855 [1.2KB])

· Object { constructor, getColumnNumber, getEnclosingColumnNumber, getEnclosingLineNumber, getEvalOrigin, ... }: 3.3KB (N: 3, Examples: @37765 [1.1KB] | @46007 [1.1KB] | @57319 [1.1KB])

· Object { <symbol Symbol.iterator>, constructor, get constructor, reduce, set constructor, ... }: 3.1KB (N: 3, Examples: @32999 [1KB] | @34297 [1KB] | @40201 [1KB])
  · [system / NativeContext / http://localhost:3000] --initial_iterator_prototype-->: 2

· Intl: 3.1KB (N: 3, Examples: @34789 [1KB] | @41257 [1KB] | @53475 [1KB])
  · [Window [JSGlobalObject] / http://localhost:3000] --Intl-->: 2
  · [Object [JSGlobalObject]] --Intl-->: 1

· Node: 2.8KB (N: 2, Examples: @66017 [1.8KB] | @49249 [1KB])

· Object { constructor }: 2.1KB (N: 18, Examples: @34075 [148 bytes] | @34089 [148 bytes] | @64303 [148 bytes] | @64391 [148 bytes] | @47045 [148 bytes])

· Atomics: 2.1KB (N: 3, Examples: @34781 [712 bytes] | @41281 [712 bytes] | @53477 [712 bytes])
  · [Window [JSGlobalObject] / http://localhost:3000] --Atomics-->: 2
  · [Object [JSGlobalObject]] --Atomics-->: 1

· Reflect: 1.8KB (N: 3, Examples: @34795 [616 bytes] | @40929 [616 bytes] | @53463 [616 bytes])
  · [Window [JSGlobalObject] / http://localhost:3000] --Reflect-->: 2
  · [Object [JSGlobalObject]] --Reflect-->: 1

· Object { csi, loadTimes }: 1.7KB (N: 2, Examples: @34065 [896 bytes] | @41101 [884 bytes])
  · [Window [JSGlobalObject] / http://localhost:3000] --chrome-->: 2

· HTMLButtonElement (prototype) / http://localhost:3000: 1.7KB (N: 2, Examples: @69573 [1KB] | @50277 [652 bytes])

· v: 1.6KB (N: 1, Examples: @71115 [1.6KB])
  · [system / Context / scope --P-->: 1
  · [Object] --customQuerySelectors-->: 1

· Set: 1.6KB (N: 6, Examples: @34305 [404 bytes] | @40209 [404 bytes] | @50807 [404 bytes] | @71123 [176 bytes] | @71127 [156 bytes])
  · [system / NativeContext / http://localhost:3000] --initial_set_prototype-->: 2
  · [Window [JSGlobalObject] / http://localhost:3000] --openedDialogs-->: 1
  · [system / Context / scope --openedDialogs-->: 1
  · [system / Context / scope --re-->: 1

· ArrayBuffer: 1.6KB (N: 3, Examples: @37609 [536 bytes] | @44305 [536 bytes] | @55809 [536 bytes])

· Object { constructor, result, start, stop }: 1.4KB (N: 3, Examples: @71243 [476 bytes] | @71259 [476 bytes] | @71275 [476 bytes])

· WebAssembly: 1.4KB (N: 3, Examples: @33645 [472 bytes] | @34539 [472 bytes] | @40445 [472 bytes])
  · [Window [JSGlobalObject] / http://localhost:3000] --WebAssembly-->: 2
  · [system / NativeContext / http://localhost:3000] --wasm_webassembly_object-->: 2
  · [Object [JSGlobalObject]] --WebAssembly-->: 1

· Object { <symbol Symbol.toStringTag>, adoptText, constructor, get adoptText, resolvedOptions, ... }: 1.3KB (N: 3, Examples: @36165 [448 bytes] | @45383 [448 bytes] | @56739 [448 bytes])

· AsyncDisposableStack: 1.3KB (N: 3, Examples: @36037 [444 bytes] | @44157 [444 bytes] | @55661 [444 bytes])

· DisposableStack: 1.3KB (N: 3, Examples: @37271 [444 bytes] | @45789 [444 bytes] | @57145 [444 bytes])
```

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

```text
$ memlab analyze object-size --snapshot /tmp/memlab-example/leak/data/cur/s3.heapsnapshot
· @71395 Array: 3 edges, 800KB, refs: [history]
· @32151 Window (prototype) / http://localhost:3000: 535 edges, 26.7KB, refs: [__proto__, prototype]
· @46239 Window (prototype) / http://localhost:3000: 535 edges, 26.7KB, refs: [prototype, __proto__]
· @32601 object shape system / DescriptorArray: 1620 edges, 9.9KB, refs: [descriptors]
· @46589 object shape system / DescriptorArray: 1620 edges, 9.9KB, refs: [descriptors]
· @65837 string string: 2 edges, 9.7KB, refs: [source]
· @65097 Document: 576 edges, 8.6KB, refs: [prototype, __proto__]
· @68575 Element: 342 edges, 7.6KB, refs: [__proto__, prototype]
· @71101 system / Context / scope @66489: 47 edges, 7KB, refs: [createFunction, fe, pQuerySelector, $, pQuerySelectorAll, de, U, V, q, xpathQuerySelectorAll]
· @47971 string string: 4 edges, 6.9KB, refs: [parent, settingNames]
· @71393 Array: 243 edges, 6.2KB, refs: [labels]
· @69421 HTMLElement: 412 edges, 4.8KB, refs: [__proto__, prototype]
· @70271 SVGElement: 341 edges, 4.5KB, refs: [prototype]
· @71055 object shape system / DescriptorArray: 441 edges, 3KB, refs: [descriptors]
· @17139 string string: 4 edges, 2.7KB, refs: [source]
· @67513 closure t: 12 edges, 2.4KB, refs: [constructor, t, c, Deferred]
· @7393 Object { constructor, toDateString, toISOString, toString, toTimeString, ... }: 51 edges, 2.1KB, refs: [prototype]
· @7533 Object { constructor, toDateString, toISOString, toString, toTimeString, ... }: 51 edges, 2.1KB, refs: [prototype]
· @7721 Object { constructor, toDateString, toISOString, toString, toTimeString, ... }: 51 edges, 2.1KB, refs: [prototype]
· @71005 object shape system / DescriptorArray: 271 edges, 2.1KB, refs: [descriptors]
· @67717 object shape system / Map: 15 edges, 2.1KB, refs: [map]
· @34799 Math: 49 edges, 1.8KB, refs: [value, Math]
· @40873 Math: 49 edges, 1.8KB, refs: [value, Math]
· @53461 Math: 49 edges, 1.8KB, refs: [value, Math]
· @7497 closure RegExp: 70 edges, 1.8KB, refs: [constructor, value, RegExp, regexp_function]
· @7685 closure RegExp: 70 edges, 1.8KB, refs: [constructor, value, RegExp, regexp_function]
· @41139 console: 31 edges, 1.8KB, refs: [value, console]
· @53467 console: 31 edges, 1.8KB, refs: [value, console]
· @66017 Node: 68 edges, 1.8KB, refs: [__proto__, prototype]
· @7881 closure RegExp: 70 edges, 1.7KB, refs: [constructor, value, RegExp, regexp_function]
· @64283 string string: 2 edges, 1.7KB, refs: [source]
· @48235 closure SettingsDialog: 10 edges, 1.7KB, refs: [constructor]
· @70999 object shape system / DescriptorArray: 283 edges, 1.7KB, refs: [descriptors]
```

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

```text
$ memlab analyze unbound-object --snapshot-dir /tmp/memlab-example/series/data/cur
Top growing objects in sizes:
 (Use `memlab trace --node-id=@ID` to get trace)

· Window [JSGlobalObject] / http://localhost:3000 [object](@40065):  45.9KB > 49.4KB > 49.4KB > 49.4KB > 49.4KB > 49.4KB > 49.4KB > 49.4KB > 49.4KB
```

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

```text
$ memlab analyze unbound-shape --snapshot-dir /tmp/memlab-example/series/data/cur
· string: 6506 (35.4KB) > 7162 (58.7KB) > 7162 (58.7KB) > 7402 (63.5KB) > 7402 (63.5KB) > 7642 (68.3KB) > 7642 (68.3KB) > 7882 (73.1KB) > 7882 (73.1KB): @71, @71, @71, @71, @71, @71, @71, @71, @71
```

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

```text
$ memlab analyze string --snapshot /tmp/memlab-example/leak/data/cur/s3.heapsnapshot

All strings
·Count: 5332 (4.09% are duplicated)
·Size: 38.8KB (1.31% are duplicated)

JS code string
·Count: 1 (0% are duplicated)
·Size: 0 byte (NaN% are duplicated)

Top duplicated strings in count
 ·[5, 0 byte]: "NaN"
 ·[4, 0 byte]: "0"
 ·[3, 0 byte]: "1"
 ·[3, 0 byte]: "2"
 ·[3, 0 byte]: "3"
 ·[3, 0 byte]: "4"
 ·[3, 0 byte]: "5"
 ·[3, 0 byte]: "6"
 ·[3, 0 byte]: "7"
 ·[3, 0 byte]: "8"

Top duplicated strings in size:

 ·[160 bytes, 2]: "Objects of type internal cannot be created using the constructor."
    node examples: @34051, @34115

 ·[108 bytes, 3]: "WebAssembly.Suspending"
    node examples: @50671, @50753, @50759

 ·[64 bytes, 3]: "HTMLButtonElement"
    node examples: @13159, @50139, @69443

 ·[48 bytes, 2]: "WebAssembly"
    node examples: @8087, @15801

 ·[48 bytes, 3]: "HTMLElement"
    node examples: @12217, @49265, @68585

 ·[48 bytes, 3]: "EventTarget"
    node examples: @14023, @50881, @51245

 ·[40 bytes, 3]: "Document"
    node examples: @13025, @51037, @51463

 ·[36 bytes, 2]: "WebAssembly.Exception"
    node examples: @1899, @8065

 ·[36 bytes, 2]: "get [Symbol.toStringTag]"
    node examples: @12273, @71175

 ·[32 bytes, 2]: "WebAssembly.Module"
    node examples: @1901, @8015
```

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
