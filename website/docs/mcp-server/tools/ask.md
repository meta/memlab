---
title: "None of the above — ask the heap directly"
description: "None of the above — ask the heap directly"
sidebar_label: Custom queries
sidebar_position: 9
custom_edit_url: null
---

These tools are in the `ask` toolset. Starting the server with
`MEMLAB_TOOLSETS=ask` exposes only them, plus the few tools every
session needs, and `memlab_tools({enable: "ask"})` turns them on
in a session. Try them in the order listed.

| Tool | Use it when |
| --- | --- |
| `memlab_eval` | Arbitrary JS over the snapshot, with indexed helpers (`byClass`, `iterByType`, `classCounts`, `entries`, `dominates`, `pathBetween`). Use `mode:"describe_env"` for the calling convention. This is the escape hatch when no fixed-shape tool matches the question. |
| `memlab_eval_across` | The same eval program run against several snapshots at once — resident ones, or files and round rungs it loads one at a time — comparative questions without the switch-and-diff. `format: "table"` prints scalar results as one key × rung table with a Δ column. |
| `memlab_auto_investigate` | When you do not yet have a question: runs the standard deep-dive and reports what it found. |
| `memlab_tools` | This index. Filter it with `question` or look a tool up with `tool`. |
