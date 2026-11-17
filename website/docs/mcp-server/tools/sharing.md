---
title: "Sharing a capture outside its trust boundary"
description: "Sharing a capture outside its trust boundary"
sidebar_label: Sharing a capture
sidebar_position: 10
custom_edit_url: null
---

These tools are in the `sharing` toolset. Starting the server with
`MEMLAB_TOOLSETS=sharing` exposes only them, plus the few tools every
session needs, and `memlab_tools({enable: "sharing"})` turns them on
in a session. Try them in the order listed.

| Tool | Use it when |
| --- | --- |
| `memlab_anonymize_snapshot` | Rewrite a capture so it can be attached to a task or handed to a model, keeping it analyzable — and reporting the identifier-shaped text it could NOT classify. Also audits a capture someone else anonymized: one such file still carried 26,303 account handles as property names. |
