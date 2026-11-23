/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * Huge-heap regression gate (opt-in; minutes and ~10 GB of RAM, so it is not
 * part of test-units):
 *
 *   node scripts/check-huge-heap.mjs [--nodes N] [--keep] [--file F] [--server S]
 *
 * `--file` reuses a snapshot a `--keep` run left behind; `--server` runs
 * another build's `dist/index.js` (with a 32 GB heap) instead of the stock bin.
 *
 * Writes a synthetic snapshot with more than 2^24 nodes (a binary tree of
 * objects), starts the server through the stock `bin/memlab-mcp.js` with no
 * NODE_OPTIONS, and runs the whole-heap tools on it. It fails when a tool:
 *  (a) throws `Map/Set maximum size exceeded`,
 *  (b) stops on the scan budget without returning anything else, or
 *  (c) refuses the already-loaded file by path.
 */
import assert from 'assert/strict';
import {spawn} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {fileURLToPath} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, '..', 'bin', 'memlab-mcp.js');
const argv = process.argv.slice(2);
const nodesArg = argv.indexOf('--nodes');
const N = nodesArg >= 0 ? Number(argv[nodesArg + 1]) : 2 ** 24 + 4096;
const keep = argv.includes('--keep');
const opt = name => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const reuseFile = opt('--file');
const serverEntry = opt('--server');
// modulesMap entries; they point at nodes 3..REG+2, so N must cover those.
const REG = 256;
if (!Number.isInteger(N) || N < REG + 3) {
  console.error(`check-huge-heap: --nodes must be an integer >= ${REG + 3}.`);
  process.exit(2);
}
// A tool on a 2^24-node heap takes minutes; one that takes this long hung.
const CALL_TIMEOUT_MS = 30 * 60_000;

/**
 * Stream a valid V8 heap snapshot: node 0 is the root and node i holds
 * i*2+1 and i*2+2. Node 2 also holds a `modulesMap` (the last node) with
 * REG entries, so module attribution has a registry to walk.
 */
async function writeSnapshot(file, n) {
  const out = fs.createWriteStream(file);
  const write = s =>
    out.write(s) ? Promise.resolve() : new Promise(r => out.once('drain', r));
  const reg = n - 1;
  const edges = n - 1 + 1 + REG;
  await write(
    JSON.stringify({
      snapshot: {
        meta: {
          node_fields: [
            'type',
            'name',
            'id',
            'self_size',
            'edge_count',
            'trace_node_id',
            'detachedness',
          ],
          node_types: [
            [
              'hidden',
              'array',
              'string',
              'object',
              'code',
              'closure',
              'regexp',
              'number',
              'native',
              'synthetic',
              'concatenated string',
              'sliced string',
              'symbol',
              'bigint',
              'object shape',
            ],
            'string',
            'number',
            'number',
            'number',
            'number',
            'number',
          ],
          edge_fields: ['type', 'name_or_index', 'to_node'],
          edge_types: [
            [
              'context',
              'element',
              'property',
              'internal',
              'hidden',
              'shortcut',
              'weak',
            ],
            'string_or_number',
            'node',
          ],
          trace_function_info_fields: [
            'function_id',
            'name',
            'script_name',
            'script_id',
            'line',
            'column',
          ],
          trace_node_fields: [
            'id',
            'function_info_index',
            'count',
            'size',
            'children',
          ],
          sample_fields: ['timestamp_us', 'last_assigned_id'],
          location_fields: ['object_index', 'script_id', 'line', 'column'],
        },
        node_count: n,
        edge_count: edges,
        trace_function_count: 0,
      },
    }).slice(0, -1) + ',"nodes":[',
  );
  // strings: 0 '', 1 'Node', 2 'a', 3 'b', 4 'modulesMap', 5.. 'm<k>'
  const kids = i =>
    (2 * i + 1 < n ? 1 : 0) +
    (2 * i + 2 < n ? 1 : 0) +
    (i === 2 ? 1 : 0) +
    (i === reg ? REG : 0);
  let buf = [];
  for (let i = 0; i < n; i++) {
    // type 9 = synthetic for the root, 3 = object otherwise.
    buf.push(
      `${i ? ',' : ''}${i === 0 ? 9 : 3},${i === 0 ? 0 : 1},${2 * i + 1},${i === 0 ? 0 : 32},${kids(i)},0,0`,
    );
    if (buf.length >= 100000) {
      await write(buf.join(''));
      buf = [];
    }
  }
  await write(buf.join('') + '],"edges":[');
  buf = [];
  let first = true;
  for (let i = 0; i < n; i++) {
    for (const [c, name] of [
      [2 * i + 1, 2],
      [2 * i + 2, 3],
    ]) {
      if (c >= n) continue;
      buf.push(`${first ? '' : ','}2,${name},${c * 7}`);
      first = false;
    }
    if (i === 2) buf.push(`,2,4,${reg * 7}`);
    if (i === reg) {
      for (let k = 0; k < REG; k++) buf.push(`,2,${5 + k},${(3 + k) * 7}`);
    }
    if (buf.length >= 100000) {
      await write(buf.join(''));
      buf = [];
    }
  }
  await write(
    buf.join('') +
      '],"trace_function_infos":[],"trace_tree":[],"samples":[],"locations":[],"strings":' +
      JSON.stringify([
        '',
        'Node',
        'a',
        'b',
        'modulesMap',
        ...Array.from({length: REG}, (_, k) => `m${k}`),
      ]) +
      '}',
  );
  await new Promise(r => out.end(r));
}

class Client {
  constructor() {
    const env = {...process.env};
    delete env.NODE_OPTIONS;
    const args =
      serverEntry != null ? ['--max-old-space-size=32768', serverEntry] : [bin];
    this.proc = spawn(process.execPath, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      env,
    });
    this.buf = '';
    this.next = 1;
    this.pending = new Map();
    this.dead = null;
    const die = why => {
      this.dead ??= why;
      for (const {reject} of this.pending.values()) {
        reject(new Error(this.dead));
      }
      this.pending.clear();
    };
    this.proc.on('error', e => die(`server failed to start: ${e.message}`));
    this.proc.stdin.on('error', e => die(`server stdin: ${e.message}`));
    this.proc.on('exit', (code, signal) =>
      die(`server exited (${signal ?? `code ${code}`})`),
    );
    // Chunks split multi-byte characters such as the '⚠' check (b) matches.
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', d => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (line.trim() === '') continue;
        const m = JSON.parse(line);
        if (m.id != null && this.pending.has(m.id)) {
          this.pending.get(m.id).resolve(m);
          this.pending.delete(m.id);
        }
      }
    });
  }
  request(method, params) {
    if (this.dead != null) return Promise.reject(new Error(this.dead));
    const id = this.next++;
    this.proc.stdin.write(
      JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n',
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no reply in ${CALL_TIMEOUT_MS / 60_000} min`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: m => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: e => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }
  async call(name, args) {
    const m = await this.request('tools/call', {name, arguments: args});
    if (m.error != null)
      return {text: `MCP error: ${m.error.message}`, isError: true};
    return {
      text: (m.result.content ?? []).map(c => c.text ?? '').join('\n'),
      isError: m.result.isError === true,
    };
  }
}

const dir =
  reuseFile != null
    ? path.dirname(reuseFile)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'memlab-huge-'));
const file = reuseFile ?? path.join(dir, 'huge.heapsnapshot');
const t0 = Date.now();
if (reuseFile == null) await writeSnapshot(file, N);
console.log(
  `wrote ${N.toLocaleString()} nodes (${(fs.statSync(file).size / 2 ** 20).toFixed(0)} MB) in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
);

const client = new Client();
const failures = [];
const run = async (name, args, {allowError = false} = {}) => {
  const s = Date.now();
  let text = '';
  let isError = false;
  const problems = [];
  try {
    ({text, isError} = await client.call(name, args));
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
  const secs = ((Date.now() - s) / 1000).toFixed(1);
  if (/maximum size exceeded/i.test(text))
    problems.push('Map/Set maximum size exceeded');
  if (/^⚠ Analysis stopped/m.test(text) && text.split('\n').length < 12)
    problems.push('stopped on the scan budget with no output');
  if (/per-file (safety )?limit|over the max_file_size_mb/.test(text))
    problems.push('refused the loaded file by path');
  if (/does not accept/.test(text))
    problems.push(`rejected an argument: ${text.split('\n')[0]}`);
  if (isError && !allowError) problems.push(`error: ${text.slice(0, 200)}`);
  console.log(
    `${problems.length ? 'FAIL' : 'ok  '} ${name} ${secs}s${problems.length ? ` — ${problems.join('; ')}` : ''}`,
  );
  if (problems.length) failures.push(`${name}: ${problems.join('; ')}`);
  return text;
};

try {
  await client.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: {name: 'check-huge-heap', version: '1'},
  });
  client.proc.stdin.write(
    JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) +
      '\n',
  );
  await run('memlab_load_snapshot', {
    file_path: file,
    max_file_size_mb: 100000,
    force: true,
  });
  await run('memlab_module_attribution', {});
  await run('memlab_island_doors', {
    seed_node_ids: [5],
    island_mode: 'dominated',
    limit: 5,
  });
  await run('memlab_trace_dominators', {node_id: 5});
  await run('memlab_drill_to_heavy_leaf', {node_id: 5});
  await run('memlab_class_histogram', {limit: 5});
  await run('memlab_sweep', {});
  // (c): the loaded file by path, with a limit far below its size.
  await run(
    'memlab_detached_dom',
    {paths: [file, file], max_file_size_mb: 1},
    {allowError: true},
  );
} catch (e) {
  failures.push(`initialize: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  client.proc.kill('SIGTERM');
  if (!keep && reuseFile == null) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}
assert.deepEqual(
  failures,
  [],
  `huge-heap gate failed:\n${failures.join('\n')}`,
);
console.log('check-huge-heap: all tools passed');
