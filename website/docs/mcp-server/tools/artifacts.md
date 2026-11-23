---
title: "Is it real, or a measurement artifact?"
description: "Is it real, or a measurement artifact?"
sidebar_label: Measurement artifacts
sidebar_position: 4
custom_edit_url: null
---

These tools are in the `artifacts` toolset. Starting the server with
`MEMLAB_TOOLSETS=artifacts` exposes only them, plus the few tools every
session needs, and `memlab_tools({enable: "artifacts"})` turns them on
in a session. Try them in the order listed.

| Tool | Use it when |
| --- | --- |
| `memlab_artifact_budget` | ONE number for how much of the heap is not the application — and, with a baseline, how much of the GROWTH was the app. `app_delta` is the number that should lead a report; `windows` also gives it without the app's bounded retention windows. |
| `memlab_replicate` | Does the effect REPRODUCE across independently-driven runs? Refuses to call it real until it does — the guard against filing a one-off. |
| `memlab_blink_native_census` | Native (Blink) classes growing across a ladder, split into JS-held (app-releasable) vs browser-internal, with fixed-capacity browser buffers annotated and uncapped holders (ordered scopes, performance entries, listener and style data) rated per cycle by name. The battery runs it in every profile. |
| `memlab_dev_artifacts` | Memory retained ONLY by dev/automation roots — DevTools, extensions, React Fast Refresh, the a11y cache. Run before calling anything a production leak; `node_ids` splits named objects into tooling-only and app-held bytes, with a path that avoids the tooling. |
| `memlab_explain_delta` | Sums the OTHER artifact family — V8 engine code (JIT warmup, code flushing) — in its own line; dev_artifacts does not count it. Read both. |
| `memlab_check_health` | Prioritized triage that separates likely-real from likely-noise. |
