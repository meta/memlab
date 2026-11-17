---
title: Get a Heap Snapshot
---

The MCP server analyzes heap snapshots: `.heapsnapshot` files, and
`.heaptimeline` files recorded with allocation tracking on. Save them where
the server can read them. Gzipped snapshots (`<file>.gz`) load too.

## From Chrome DevTools

1. Open DevTools (F12) and go to the **Memory** tab.
2. Select **Heap snapshot** and click **Take snapshot**.
3. Right-click the snapshot in the left panel and choose **Save...**.

To record where objects were allocated, choose **Allocations on timeline**
instead, and save the `.heaptimeline` file. Then `memlab_allocation_sites` groups live objects by
the stack that allocated them.

## From a Live Page

The assistant can take snapshots of a running page itself, including its
dedicated workers, which a page snapshot never contains.

1. Start Chrome with remote debugging on, in a separate profile (Chrome 136
   and later ignore the port flag on your default profile), by passing these
   flags:

   ```bash
   --remote-debugging-port=9222 --user-data-dir=<a temporary directory>
   ```

2. Open your page in that Chrome.
3. Ask the assistant to take a snapshot with `memlab_capture`, into an output
   directory. With `list_targets: true`, it lists the pages to choose from.

Give each capture a `label`. Later, wherever a snapshot path is accepted, the
assistant can refer to it as `checkpoint:<label>`. For example, it can compare
two captures with
`memlab_diff_snapshots({before: "checkpoint:baseline", after: "checkpoint:after"})`.
`memlab_realm_summary` compares the page with its workers.

To check an idea against the running app, `memlab_live_eval` evaluates one
expression in the page and returns its value as JSON. It refuses any
expression that V8 can't prove is free of side effects, unless
`allow_side_effects` is set, and stops after `timeout_s` seconds.

## From Node.js

```js
const v8 = require('v8');
const snapshot = v8.writeHeapSnapshot();
console.log(`Heap snapshot written to ${snapshot}`);
```

## From memlab

[`memlab run`](../cli/run.md) and [`memlab snapshot`](../cli/snapshot.md)
save a snapshot after each step of a scenario, in the `data/cur` directory
of their working directory (`memlab get-default-work-dir` prints the
default). The server loads them as they are.

To measure growth, take a series of snapshots while an interaction repeats:
see [Snapshot Ladders](./snapshot-ladders.md).
