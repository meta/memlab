---
title: Tool Permissions and Safety
---

No tool ever changes the heap snapshot it analyzes, and most tools only read
it. Two groups of tools are exceptions: the ones that run JavaScript, and the
ones with side effects outside the heap.

Every tool declares MCP annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint` and a `title`). A client that honors them
can approve the read-only tools automatically and keep asking about the
others.

## Tools That Run JavaScript

:::danger Do not auto-approve these tools

These tools run JavaScript that the assistant passes in, or that they read
from a round directory, with the full privileges of the MCP server process:

- `memlab_eval` and `memlab_eval_across`
- `memlab_live_eval`, which runs its code in your live page, with the page's
  session
- `memlab_for_each`
- `memlab_hypothesis`
- `memlab_ladder_probe` and `memlab_replicate`
- `memlab_judges`, `memlab_calibrate_judges` and `memlab_switch_matrix`
- `memlab_ab_compare`
- `memlab_analysis_battery`, when the round has an `invariants.json`

`memlab_batch` and `memlab_start_job` can call any of them.

:::

These tools use `node:vm` to limit the globals they provide, but
[`node:vm` is not a security sandbox](https://nodejs.org/api/vm.html): code
can reach the filesystem, the network and the shell. A heap snapshot's
contents can come from an attacker, so a prompt injection hidden in a
snapshot could steer the assistant into running harmful code.

- Keep these tools on manual approval.
- Don't allowlist `mcp__memlab__*` with a wildcard: it approves these tools
  too.
- To turn them off completely, start the server with
  `MEMLAB_DISABLE_CODE_TOOLS=1`.

## Tools with Side Effects

These tools don't run your code, but they do more than read the snapshot:

- `memlab_capture` connects to a running Chrome and writes snapshots.
- `memlab_prune_run` compresses or deletes a round's snapshot files. By
  default it only reports what it would do.
- `memlab_anonymize_snapshot` and `memlab_analysis_battery` write files.
- `memlab_finding_index`, `memlab_metric` and `memlab_ladder` keep small state
  files in your home directory.

## Approve the Read-Only Tools You Use

To stop your assistant from asking on every call, while keeping the tools
above on manual approval, allowlist the read-only tools you use by name. In
Claude Code, add them to `~/.claude/settings.json` (for every project) or
`.claude/settings.json` (for one project):

```json
{
  "permissions": {
    "allow": [
      "mcp__memlab__memlab_tools",
      "mcp__memlab__memlab_load_snapshot",
      "mcp__memlab__memlab_snapshot_header",
      "mcp__memlab__memlab_snapshots",
      "mcp__memlab__memlab_app_heap",
      "mcp__memlab__memlab_snapshot_summary",
      "mcp__memlab__memlab_class_histogram",
      "mcp__memlab__memlab_retainer_trace"
    ]
  }
}
```
