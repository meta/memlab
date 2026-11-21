---
title: "Collections and caches"
description: "Collections and caches"
sidebar_label: Collections and caches
sidebar_position: 6
custom_edit_url: null
---

These tools are in the `collections` toolset. Starting the server with
`MEMLAB_TOOLSETS=collections` exposes only them, plus the few tools every
session needs, and `memlab_tools({enable: "collections"})` turns them on
in a session. Try them in the order listed.

| Tool | Use it when |
| --- | --- |
| `memlab_collection_diff` | WHICH collections grew across a ladder, without being told their names — censuses every Map/Set/Array and keys each by a stable `<Owner>.<property>` signature. |
| `memlab_weakref_census` | Every WeakRef, split LIVE vs EMPTY, grouped by the shape of the holder. |
| `memlab_cache_analysis` | Unbounded or oversized caches in one snapshot. |
| `memlab_collection_census` | Every collection with at least N entries at any depth, with an element split (null, holes, no-op wrappers, detached DOM, cancelled Scheduler tasks, top shapes) that flags rows at least 25% dead. |
| `memlab_persistent_structures` | How many VERSIONS of a structurally-shared structure are retained (Immutable.js, Immer, RxJS) — detected by SHAPE, so it survives the minified class names a histogram cannot explain. |
| `memlab_sparse_elements` | Integer-keyed objects and arrays whose elements backing store is mostly holes — waste charged to no class, so a histogram cannot see it. |
| `memlab_id_space_audit` | Separate integer-keyed structures indexed by the SAME sparse id space — several small sparse findings that are really one re-keying fix. |
| `memlab_stale_collections` | Collections holding entries nothing else references. |
| `memlab_collection_trend` | The same collections tracked ACROSS a ladder. |
| `memlab_map_entries` | Enumerate a Map/Set correctly (SMI gaps and browser slot typing handled). |
| `memlab_weakmap_entries` | Enumerate a WeakMap. |
| `memlab_array_group_by` | Group an array’s elements by a property to see what is piling up. |
| `memlab_property_distribution` | Cardinality and top values of one property across instances. |
| `memlab_field_fill` | Every field of a record collection at once: % null, constant, empty, per-record copies vs shared, plus timestamp span / rate / age. Tells empty stubs and copied arrays from real content. |
| `memlab_finished_state` | Objects whose own status says FINISHED (traceStatus SUCCESS, completed:true, aborted, UPLOAD_PENDING, empty observers) but that still own big buffers, by holder; with 2+ snapshots, whether the buffer still grows. |
