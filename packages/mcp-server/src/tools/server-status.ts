/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {execFile} from 'child_process';
import fs from 'fs';
import {z} from 'zod';
import {perfSnapshot} from '../perf-stats.js';
import {SERVER_VERSION} from '../server-version.js';
import {fixStatusCommand, lastFixStatusOutcome} from '../fix-status.js';
import {reaperEvents, reaperSettings} from '../memory-reaper.js';
import {listSnapshots, getCurrentHandle} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  errorResult,
  markdownTable,
  textResult,
} from '../utils.js';

/**
 * The plugin's stable scripts path, when the launcher exported one. The plugin
 * cache directory is versioned and an update deletes the old version, so a
 * harness must import scripts from the stable path, never the versioned one.
 */
function stableScriptsPath(): {stable: string; resolved: string | null} | null {
  const stable = process.env.MEMLAB_SCRIPTS;
  if (stable == null || stable === '') return null;
  let resolved: string | null = null;
  try {
    resolved = fs.realpathSync(stable);
  } catch {
    resolved = null;
  }
  return {stable, resolved};
}

/**
 * Every memlab server process on this host, from `ps`: an orphaned server
 * (its client gone) can hold gigabytes of snapshots with nothing using it,
 * and the status of THIS process cannot show it.
 */
export async function memlabServerProcesses(): Promise<
  Array<{
    pid: number;
    ppid: number;
    rssMb: number;
    ageS: number;
    args: string;
  }>
> {
  // Asynchronous: a status call must not block the event loop for `ps`.
  const out = await new Promise<string | null>(resolve => {
    execFile(
      'ps',
      ['-eo', 'pid=,ppid=,rss=,etimes=,args='],
      {encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024},
      (err, stdout) => resolve(err != null ? null : String(stdout)),
    );
  });
  if (out == null) return [];
  const rows = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m == null) continue;
    const args = m[5];
    // The server entry, or a `memlab-cli serve` wrapper.
    const self = Number(m[1]) === process.pid;
    if (
      !self &&
      (!/memlab/i.test(args) ||
        !(
          /dist\/index\.js\b/.test(args) ||
          /memlab-cli\.js\s+serve\b/.test(args)
        ))
    ) {
      continue;
    }
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssMb: Math.round(Number(m[3]) / 1024),
      ageS: Number(m[4]),
      args: args.slice(0, 160),
    });
  }
  return rows;
}

function age(s: number): string {
  return s >= 86400
    ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
    : s >= 3600
      ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
      : `${Math.floor(s / 60)}m`;
}

export function registerServerStatus(server: McpServer): void {
  server.tool(
    'memlab_server_status',
    'Cheap liveness/health check: returns instantly with the server VERSION, process RSS, uptime, and the resident snapshots. The version answers "is the attached server actually my local build?" — a running server keeps old code in memory after a rebuild, and the only previous way to tell was a hand-rolled JSON-RPC initialize handshake. Use it to confirm the server is responsive (vs. stuck behind a heavy scan) and to watch RSS against the snapshot-size ceiling. Scan tools are time-budgeted (timeout_ms) so a heavy scan returns cleanly instead of wedging the server; if a call ever seems hung, this check should still answer immediately. It also reports the idle-unload / RSS soft-cap settings and what they unloaded; `all: true` lists every memlab server process on the host (pid, parent, RSS, age), so an orphaned one holding gigabytes is visible.',
    {
      all: z
        .boolean()
        .optional()
        .describe(
          'Also list every memlab server process on this host (from `ps`), with its parent pid, RSS and age.',
        ),
    },
    async ({all: listAll}) => {
      try {
        const mem = process.memoryUsage();
        const uptimeS = Math.round(process.uptime());
        const version = SERVER_VERSION;
        const all = listSnapshots();
        const cur = getCurrentHandle();
        const lines = [
          '## memlab server status',
          '',
          `- Status: ready`,
          `- Server version: **${version}**`,
          `- Uptime: ${uptimeS}s`,
          `- Process RSS: ${formatBytes(mem.rss)} (heapUsed ${formatBytes(mem.heapUsed)} / heapTotal ${formatBytes(mem.heapTotal)})`,
          `- Resident snapshots: ${all.length}`,
        ];
        const scripts = stableScriptsPath();
        if (scripts != null) {
          lines.splice(
            lines.length - 1,
            0,
            `- Plugin scripts (stable across plugin updates): \`${scripts.stable}\`` +
              (scripts.resolved != null ? ` → \`${scripts.resolved}\`` : ''),
          );
        }
        for (const m of all) {
          lines.push(
            `  ${m.handle === cur ? '→' : ' '} ${m.handle} — ${m.fileName}, ${formatBytes(m.totalSize)}, ${formatNumber(m.nodeCount)} nodes`,
          );
        }
        if (all.length === 0) {
          lines.push('  (none loaded — use memlab_load_snapshot)');
        }
        const reaper = reaperSettings();
        const reaped = reaperEvents();
        lines.push(
          `- Memory reaper: idle unload after ${reaper.idleMin > 0 ? `${reaper.idleMin} min (\`MEMLAB_IDLE_UNLOAD_MIN\`)` : 'OFF'}, RSS soft cap ${reaper.rssCapMb != null ? `${formatNumber(reaper.rssCapMb)} MB` : 'none (`MEMLAB_RSS_SOFT_CAP_MB`)'}` +
            (reaped.length > 0
              ? `; unloaded ${reaped
                  .slice(-5)
                  .map(e => `${e.handle} (${e.reason})`)
                  .join(', ')}`
              : ''),
        );
        const fixCmd = fixStatusCommand();
        if (fixCmd != null) {
          const last = lastFixStatusOutcome();
          lines.push(
            `- Fix-status lookup (\`MEMLAB_FIX_STATUS_CMD\`): configured` +
              (last == null
                ? '; not used yet in this process'
                : last.ok
                  ? `; last lookup (${last.diff}) OK`
                  : `; last lookup (${last.diff}) FAILED: ${last.detail}`),
          );
        }
        const perf = perfSnapshot();
        lines.push(
          '',
          `**Peak RSS:** ${formatBytes(perf.peakRss)} since start` +
            (perf.evictions.length > 0
              ? `; ${formatNumber(perf.evictions.length)} snapshot(s) evicted to make room (${perf.evictions.map(e => e.handle).join(', ')})`
              : ''),
        );
        if (perf.loads.length > 0) {
          lines.push(
            '',
            '**Recent loads**',
            '',
            markdownTable(
              ['File', 'Kind', 'Nodes', 'Time', 'RSS before → after'],
              perf.loads
                .slice(-5)
                .reverse()
                .map(l => [
                  l.file,
                  l.kind,
                  formatNumber(l.nodes),
                  `${l.seconds.toFixed(1)} s`,
                  `${formatBytes(l.rssBefore)} → ${formatBytes(l.rssAfter)}`,
                ]),
              new Set([2, 3]),
            ),
          );
        }
        if (perf.slowestTools.length > 0) {
          lines.push(
            '',
            '**Slowest tools** (this session)',
            '',
            markdownTable(
              ['Tool', 'Calls', 'Max', 'Mean', 'Last'],
              perf.slowestTools.map(t => [
                t.tool,
                formatNumber(t.count),
                `${(t.maxMs / 1000).toFixed(1)} s`,
                `${(t.totalMs / t.count / 1000).toFixed(1)} s`,
                `${(t.lastMs / 1000).toFixed(1)} s`,
              ]),
              new Set([1, 2, 3, 4]),
            ),
          );
        }
        lines.push(
          '',
          '_Tip: full-heap scan tools (search_nodes, find_by_property, global_variables) accept timeout_ms and return partial results rather than hanging. If RSS approaches your --max-old-space-size, unload snapshots with memlab_snapshots(action:"unload")._',
          '_Recovery: if a prior long/interrupted call left the server unresponsive (even trivial calls hang), starting a FRESH server instance fully recovers it — restart the MCP server and reload the snapshot._',
        );
        if (listAll === true) {
          const procs = await memlabServerProcesses();
          lines.push(
            '',
            `**memlab server processes on this host: ${procs.length}**`,
            '',
            procs.length === 0
              ? '(none found, or `ps` is unavailable)'
              : markdownTable(
                  ['PID', 'Parent', 'RSS', 'Age', 'Command'],
                  procs.map(p => [
                    String(p.pid) + (p.pid === process.pid ? ' (this)' : ''),
                    String(p.ppid),
                    `${formatNumber(p.rssMb)} MB`,
                    age(p.ageS),
                    `\`${p.args}\``,
                  ]),
                  new Set([2]),
                ),
            '',
            '_A server whose parent is gone (parent 1) or that is days old with gigabytes resident is usually orphaned; stop it with `memlab-cli.js stop --socket …` or kill the pid._',
          );
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
