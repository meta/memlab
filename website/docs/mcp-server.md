# MCP Server for AI Assistants

The [`@memlab/mcp-server`](https://www.npmjs.com/package/@memlab/mcp-server)
package lets an AI coding assistant investigate JavaScript memory for you. It
is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server:
it gives assistants such as Claude Code, Codex, Cursor, Windsurf and opencode
about 150 tools built on memlab's heap analysis.

Instead of clicking through the Chrome DevTools **Memory** panel, you give the
assistant a `.heapsnapshot` file and ask questions in plain language:

> Load `/tmp/my-app.heapsnapshot`, tell me what is growing, and show me the
> retainer trace for the biggest offender.

The assistant picks the tools, runs them, and explains what it finds.

## What You Can Ask

- **What is this heap made of?** How much is your app's data, how much is
  bundle source, and how much is the JavaScript engine itself.
- **Is anything growing, and is it a leak?** Given a series of snapshots
  taken while an interaction repeats, which objects grow every time, and
  whether the growth stops or keeps going.
- **Why is this object still in memory?** The chain of references that keeps
  it alive, and which reference to break.
- **Is the number real?** Whether memory is held only by DevTools, a browser
  extension or a development build, rather than by your app.

## Quick Start

You need Node.js 18 or later. In Claude Code or Codex, install the
[memlab plugin](https://github.com/meta/memlab/tree/main/plugins/memlab). It
adds the server and
[Agent Skills](https://github.com/meta/memlab/tree/main/plugins/memlab/skills)
that teach the assistant when and how to use it:

```bash
# Claude Code
claude plugin marketplace add meta/memlab
claude plugin install memlab@memlab

# Codex
codex plugin marketplace add meta/memlab
codex plugin add memlab@memlab
```

For other assistants, see [Install and Set Up](./mcp-server/setup.md).

Then take a heap snapshot of your page (in Chrome DevTools: **Memory** →
**Heap snapshot** → **Take snapshot** → right-click → **Save...**) and ask the
assistant to load it.

## Learn More

- <a id="setup"></a>[Install and Set Up](./mcp-server/setup.md): every
  install option, and how much memory the server needs.
- <a id="getting-a-heap-snapshot"></a>[Get a Heap Snapshot](./mcp-server/heap-snapshots.md):
  from Chrome DevTools, a live page, Node.js, or memlab.
- <a id="a-typical-investigation"></a>[Investigate a Heap Snapshot](./mcp-server/investigation.md):
  the steps of a typical investigation, and how to work with several
  snapshots.
- <a id="what-the-tools-can-answer"></a>[Tool Reference](./mcp-server/tools.md):
  every tool, grouped by the question it answers.
- <a id="snapshot-ladders"></a>[Snapshot Ladders](./mcp-server/snapshot-ladders.md):
  measure growth over a series of snapshots, and run long analyses.
- [Advanced Analysis](./mcp-server/advanced-analysis.md): closures and scope
  chains, served source, custom queries, saved probes, and a findings index.
- <a id="reading-the-numbers"></a>[Reading the Numbers](./mcp-server/reading-the-numbers.md):
  how memlab's figures compare with DevTools, and how its reports group
  results.
- <a id="command-line-memlab-cli"></a>[Command Line](./mcp-server/command-line.md):
  run the same tools from a shell or CI job with `memlab-cli`.
- <a id="tool-permissions-and-safety"></a>[Tool Permissions and Safety](./mcp-server/safety.md):
  which tools to keep on manual approval, and why.

## Further Reading

- [MCP server README](https://github.com/meta/memlab/blob/main/packages/mcp-server/README.md):
  the package's full reference, including the state files the server writes
  and every `MEMLAB_*` environment variable.
- [MCP investigation skill](https://github.com/meta/memlab/blob/main/packages/mcp-server/MCP_SKILL.md):
  a step-by-step method for assistants, with investigation paths for string
  waste, DOM leaks, object accumulation, closure leaks and listener
  accumulation.
- [AI assistant guide](https://github.com/meta/memlab/blob/main/AI.md):
  guidance for assistants using memlab more broadly, including writing test
  scenarios and reading retainer traces.
