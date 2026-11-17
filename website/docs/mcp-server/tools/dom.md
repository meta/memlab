---
title: "Detached DOM and event listeners"
description: "Detached DOM and event listeners"
sidebar_label: Detached DOM and listeners
sidebar_position: 5
custom_edit_url: null
---

These tools are in the `dom` toolset. Starting the server with
`MEMLAB_TOOLSETS=dom` exposes only them, plus the few tools every
session needs, and `memlab_tools({enable: "dom"})` turns them on
in a session. Try them in the order listed.

| Tool | Use it when |
| --- | --- |
| `memlab_dom_audit` | Budget the ATTACHED DOM and rank surfaces worth virtualizing. An OPTIMIZATION tool — these elements are correctly retained, there are simply too many. |
| `memlab_detached_dom` | Detached nodes, with a pinned-vs-GC-eligible split; `group_by:"dominator"` groups by what a fix would actually free (and lists every reference into a top group of 1,000+ nodes), and `baseline` adds each group's count at an earlier rung and sorts by the change. |
| `memlab_event_listener_leaks` | Listeners that outlived their target. |
| `memlab_event_registry` | What is registered on what; `group_by` emitter × context class × callback says whose listener records they are, per rung with `run_dir`; a growing row whose callback is a library wrapper (the Arbiter `→ r`) also names the subscriber behind it. |
