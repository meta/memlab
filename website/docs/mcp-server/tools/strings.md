---
title: "Strings and duplication"
description: "Strings and duplication"
sidebar_label: Strings and duplication
sidebar_position: 7
custom_edit_url: null
---

These tools are in the `strings` toolset. Starting the server with
`MEMLAB_TOOLSETS=strings` exposes only them, plus the few tools every
session needs, and `memlab_tools({enable: "strings"})` turns them on
in a session. Try them in the order listed.

| Tool | Use it when |
| --- | --- |
| `memlab_string_prefix_census` | Strings by PREFIX (`blob:`, `data:image/`, a key scheme) on every rung, from the sidecar index — seconds, not a full-graph walk per rung. |
| `memlab_intern_opportunities` | What an intern pool would actually reclaim, grouped by property x parent shape. Start here for an interning decision. |
| `memlab_duplicated_strings` | The raw per-value duplication table, plus the largest values regrouped by the object shape holding them: several duplicated fields of one shape are one object copied many times. |
| `memlab_string_patterns` | Group strings by prefix to find families (URLs, ids, payloads); `normalize:true` masks digits and names the top holders. |
| `memlab_sliced_strings` | Substrings pinning huge parents. |
| `memlab_duplicate_objects` | The same question for objects rather than strings. |
| `memlab_search_strings` | Find a string value in the heap. |
| `memlab_get_string` | Read one string node’s value. |
