---
title: Install and Set Up
---

The MCP server needs Node.js 18 or later. Pick one of the options below, then
restart your assistant so it picks up the new server.

## Claude Code and Codex Plugin

The [memlab plugin](https://github.com/meta/memlab/tree/main/plugins/memlab)
installs the server together with
[Agent Skills](https://github.com/meta/memlab/tree/main/plugins/memlab/skills)
that teach the assistant when and how to use it. This is the easiest option
for these two assistants:

```bash
# Claude Code
claude plugin marketplace add meta/memlab
claude plugin install memlab@memlab

# Codex
codex plugin marketplace add meta/memlab
codex plugin add memlab@memlab
```

## Other MCP Clients

Add the server to your client's MCP configuration: `~/.claude.json` for
Claude Code, or `.mcp.json` for Cursor and Windsurf. There are three ways to
run it.

### Run It with npx

Nothing to install first. npx downloads the package the first time:

```json
{
  "mcpServers": {
    "memlab": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "-p", "@memlab/mcp-server", "memlab-mcp"],
      "env": {
        "NODE_OPTIONS": "--max-old-space-size=8192"
      }
    }
  }
}
```

### Install It Globally

```bash
npm install -g @memlab/mcp-server
```

```json
{
  "mcpServers": {
    "memlab": {
      "type": "stdio",
      "command": "memlab-mcp",
      "env": {
        "NODE_OPTIONS": "--max-old-space-size=8192"
      }
    }
  }
}
```

### Build It from Source

```bash
git clone https://github.com/meta/memlab.git
cd memlab
npm install
npm run build
```

```json
{
  "mcpServers": {
    "memlab": {
      "type": "stdio",
      "command": "node",
      "args": [
        "--max-old-space-size=8192",
        "/path/to/memlab/packages/mcp-server/dist/index.js"
      ]
    }
  }
}
```

## opencode

opencode reads MCP servers from `opencode.json`, in its own format:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "memlab": {
      "type": "local",
      "command": ["npx", "-y", "-p", "@memlab/mcp-server", "memlab-mcp"],
      "environment": {
        "NODE_OPTIONS": "--max-old-space-size=8192"
      }
    }
  }
}
```

To use the memlab Agent Skills with opencode too, copy the directories under
[`plugins/memlab/skills/`](https://github.com/meta/memlab/tree/main/plugins/memlab/skills)
into `.opencode/skills/` in your project, or into
`~/.config/opencode/skills/`.

## Give the Server Enough Memory

The server keeps every loaded snapshot fully parsed in memory, with its
nodes, edges, dominator tree and indexes. That takes several times the
snapshot's size on disk. Always start the server with
`--max-old-space-size=8192` (8 GB) or more. Every configuration above already
does.

### Snapshots the Server Refuses to Load

To avoid crashing out of memory, which would lose every loaded snapshot,
`memlab_load_snapshot` refuses a snapshot when:

- **The file is too large.** The limit is `max_file_size_mb`: 900 MB, or a
  quarter of the server's heap limit if that is larger (2,048 MB with 8 GB).
  `MEMLAB_MAX_FILE_SIZE_MB` changes it for every call, and every tool that
  reads snapshot files takes `max_file_size_mb` for one call. A snapshot that
  is already loaded is never refused by path.
- **It has too many nodes or edges.** The limit follows from the server's
  heap limit: about 13.9 million nodes and 55.7 million edges with 8 GB.
- **It doesn't fit in the memory that is left**, even after unloading the
  snapshot that was used least recently.

A larger `--max-old-space-size` raises all three limits. To try one
oversized load anyway, ask the assistant to pass `force: true`.

`memlab_snapshot_header` tells you whether a snapshot will load without
loading it, so the assistant can check first.

### Memory Warnings

Analysis can also fill the server's heap between loads. The first time the
server's heap use passes 75%, 85% or 95% of its limit, the next tool result
starts with a one-line warning: how much heap and memory the server uses, and
how many snapshots are loaded. Each level is announced once, on the way up,
so a session with room to spare never sees a warning. Unload the snapshots
you no longer need (see
[Investigate a Heap Snapshot](./investigation.md#work-with-several-snapshots)).
