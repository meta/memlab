---
title: "Inspect or find specific objects"
description: "Inspect or find specific objects"
sidebar_label: Inspect objects
sidebar_position: 8
custom_edit_url: null
---

These tools are in the `inspect` toolset. Starting the server with
`MEMLAB_TOOLSETS=inspect` exposes only them, plus the few tools every
session needs, and `memlab_tools({enable: "inspect"})` turns them on
in a session. Try them in the order listed.

| Tool | Use it when |
| --- | --- |
| `memlab_query_objects` | Any combination of filters in one call: class regex, node type, property name, detached, self / retained size ranges like "1MB-". Sorted, paged and cached per snapshot. |
| `memlab_find_nodes_by_class` | By exact class name, or by `name_pattern` regex/substring. |
| `memlab_search_nodes` | By name/type/size predicates. |
| `memlab_find_by_property` | By a property name/value. |
| `memlab_find_by_shape` | By property set. |
| `memlab_module_present` | Is this class in the heap AT ALL? Pre-flight before instrumenting a module. |
| `memlab_match_object` | By a structural pattern. |
| `memlab_get_node` | One node’s details, with detachedness (attached / detached / unknown) and distance from the root. |
| `memlab_object_shape` | One object’s properties and their sizes. |
| `memlab_get_references` | Outgoing edges. |
| `memlab_get_referrers` | Incoming edges. |
| `memlab_get_property` | One property of one object. |
| `memlab_get_value` | A scalar value, where the format allows it. |
| `memlab_closure_inspection` | What a closure captured, and what that costs. |
| `memlab_global_variables` | What is hanging off the global object. |
| `memlab_aggregate` | Sum/count over a node set. |
| `memlab_for_each` | Run one tool over many nodes. |
