/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {spawn} from 'child_process';
import fs from 'fs';

/**
 * Run one tool call in a child copy of this server, over MCP stdio.
 *
 * The server is single-threaded and memlab's parse and dominator passes are
 * synchronous, so a deep battery running in-process (up to ~20 minutes on
 * 2 GB rungs) left every other call — an eval on the active snapshot, a
 * status check — waiting behind it. A child process has its own event loop
 * and its own heap: the parent stays responsive, and the battery's rung
 * parses do not compete with the parent's resident snapshots for old space.
 */

/** Set in the child, so it never isolates again. */
export const CHILD_ENV = 'MEMLAB_ISOLATED_CHILD';

export function isIsolatedChild(): boolean {
  return process.env[CHILD_ENV] === '1';
}

export interface ChildCall {
  /** Resolves with the tool's text, or rejects with its error. */
  done: Promise<string>;
  pid: number | undefined;
}

/**
 * Spawn `process.argv[1]` (this server's entry point) with the same node
 * flags, call `tool` once, and exit.
 */
export function callToolInChild(
  tool: string,
  args: Record<string, unknown>,
  label: string,
): ChildCall {
  const entry = process.argv[1];
  if (entry == null || !fs.existsSync(entry)) {
    return {
      done: Promise.reject(
        new Error(`cannot isolate: server entry point ${entry} not found`),
      ),
      pid: undefined,
    };
  }
  const child = spawn(process.execPath, [...process.execArgv, entry], {
    env: {...process.env, [CHILD_ENV]: '1'},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const send = (msg: object): void => {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };
  const done = new Promise<string>((resolve, reject) => {
    let buf = '';
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
      child.stdin.end();
      // The server exits when its stdin closes; this is the backstop.
      setTimeout(() => child.kill(), 5000).unref();
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === '') continue;
        let msg: {
          id?: number;
          result?: {
            content?: Array<{type: string; text?: string}>;
            isError?: boolean;
          };
          error?: {message?: string};
        };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({jsonrpc: '2.0', method: 'notifications/initialized'});
          send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {name: tool, arguments: args},
          });
        } else if (msg.id === 2) {
          if (msg.error != null) {
            const message = msg.error.message ?? 'unknown error';
            settle(() => reject(new Error(message)));
            return;
          }
          const text = (msg.result?.content ?? [])
            .filter(c => c.type === 'text')
            .map(c => c.text ?? '')
            .join('\n');
          settle(() =>
            msg.result?.isError === true
              ? reject(new Error(text.replace(/^Error:\s*/, '')))
              : resolve(text),
          );
        }
      }
    });
    // Its log lines go where the parent's go, labelled.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') process.stderr.write(`[${label}] ${line}\n`);
      }
    });
    child.on('error', err => settle(() => reject(err)));
    child.on('exit', (code, signal) =>
      settle(() =>
        reject(
          new Error(
            `the isolated ${tool} process exited (${signal ?? `code ${code}`}) before answering`,
          ),
        ),
      ),
    );
  });
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {name: 'memlab-parent', version: '1'},
    },
  });
  return {done, pid: child.pid};
}
