#!/usr/bin/env node

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

// Node's default old space (~4 GB) refuses snapshots over ~1 GB, so the server
// is re-run with a heap sized from the machine unless one was chosen already
// (--max-old-space-size, NODE_OPTIONS, or MEMLAB_MAX_OLD_SPACE_MB).
import {spawn} from 'child_process';
import {fileURLToPath} from 'url';
import {heapLimitIsSet, resolveMaxOldSpaceMB} from '../dist/launch-heap.js';

const entryUrl = new URL('../dist/index.js', import.meta.url);

if (
  process.env.MEMLAB_MCP_HEAP_SET === '1' ||
  heapLimitIsSet(process.execArgv, process.env.NODE_OPTIONS)
) {
  async function startServer() {
    await import(entryUrl.href);
  }
  startServer().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  let mb;
  try {
    mb = resolveMaxOldSpaceMB();
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
  const child = spawn(
    process.execPath,
    [
      `--max-old-space-size=${mb}`,
      ...process.execArgv,
      fileURLToPath(entryUrl),
      ...process.argv.slice(2),
    ],
    {stdio: 'inherit', env: {...process.env, MEMLAB_MCP_HEAP_SET: '1'}},
  );
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => child.kill(sig));
  }
  child.on('exit', (code, signal) => {
    if (signal != null) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}
