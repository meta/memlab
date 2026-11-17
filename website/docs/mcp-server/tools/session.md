---
title: "Session, batching and write-ups"
description: "Session, batching and write-ups"
sidebar_label: Session and batching
sidebar_position: 11
custom_edit_url: null
---

These tools are in the `session` toolset. Starting the server with
`MEMLAB_TOOLSETS=session` exposes only them, plus the few tools every
session needs, and `memlab_tools({enable: "session"})` turns them on
in a session. Try them in the order listed.

| Tool | Use it when |
| --- | --- |
| `memlab_round_digest` | The verdict table for a finished round and nothing else — the audit verdict, the ladder shape, and the per-metric rate/fit/verdict rows, without the ~30 KB of prose. `format: "doc_markdown"` gives a short write-up section instead, with `compare_to` for the previous round. |
| `memlab_sweep_digest` | One row per round across a whole sweep, plus the leak-candidate classes no earlier round reported — where the sweep found something new. |
| `memlab_round_audit` | Read a round’s run.json BEFORE analysing it, so a broken bring-up is caught before its numbers travel into a write-up. Also names recorded fixes whose `fixed_behind` prop the build does not serve (absent from the registry, or read by no served code). |
| `memlab_load_snapshot` | Load a local path, a manifold:// URL, or a bare Nest filename. |
| `memlab_snapshots` | List / switch / unload resident snapshots; set session output controls. |
| `memlab_batch` | Several tools against ONE load — the load is the expensive part. |
| `memlab_snapshot_header` | Node/edge counts WITHOUT loading the snapshot. |
| `memlab_server_status` | Confirm the server is alive (returns instantly), and see what large snapshots cost it: peak RSS, recent loads with time and RSS before/after, evictions, and the slowest tools this session. |
| `memlab_finding_index` | Record findings as you go so the write-up is not reconstructed from memory. Keyed by retainer path, or by `kind` + `keys` for update queues, collections and probes; `list` filters by round, title and kind; `cover` stores the served revision and gating hash. With `run_dir` the workstream comes from run.json; a NEW `check` lists probable duplicates to `reconfirm` instead. A fix records its `fix_outcome` once shipped, and `stale` lists fixes whose outcome was never settled or whose gate stopped serving. |
| `memlab_validate_finding` | Before filing: does the write-up declare every check (reproduced, at rest, production-like, retainer path, per-cycle rate, not a known artifact, and the fix verdict for a fix) with evidence or a reason, and were the checks its claim rests on actually measured? VALID or INVALID with each problem. |
| `memlab_reports` | Render the findings. |
| `memlab_hunt_report` | Render a leak-hunt run. |
| `memlab_analyze_run` | Point at a run.json and get the WHOLE analysis protocol — trend, owner attribution, population diff, artifact classification, caveats — in one call. |
