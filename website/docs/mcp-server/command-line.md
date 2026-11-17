---
title: Command Line
---

The `@memlab/mcp-server` package also installs `memlab-cli`, which runs the
same tools without an MCP client. Use it in a shell script or a CI job, or to
check the server when your assistant can't connect to it.

## Commands

```bash
memlab-cli doctor                      # check Node.js, the server, and a live connection
memlab-cli list                        # every tool, with a one-line description
memlab-cli schema memlab_load_snapshot # a tool's parameters, as JSON
```

`call` runs one or more tools in a single server session, each followed by
its arguments as JSON:

```bash
memlab-cli call memlab_load_snapshot '{"file_path":"/tmp/a.heapsnapshot"}' \
                memlab_app_heap '{}'
```

`script` runs the calls in a file, one `{"tool": ..., "args": {...}}` per
line:

```bash
memlab-cli script steps.jsonl
```

## Keep Snapshots Loaded Between Commands

Loading a large snapshot can take minutes, and each `call` or `script` starts
a new server. To keep snapshots loaded across commands, start one server
that stays up:

```bash
memlab-cli serve --socket /tmp/memlab.sock
```

Then pass `--socket /tmp/memlab.sock` to `call`, `script` and `stop`.

## Memory

`memlab-cli` starts the server with its own `--max-old-space-size`, which
overrides any `NODE_OPTIONS`. To change it, set `MEMLAB_MAX_OLD_SPACE_MB`. By
default it uses 60% of the machine's memory (at least 8 GB), or 60% of the
container's memory limit inside a container.
