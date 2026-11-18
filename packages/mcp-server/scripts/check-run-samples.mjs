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
 * Unit tests for run-samples.ts: the leak report's "Between rungs" summary of
 * a hunt's samples.jsonl.
 *
 *   npm run build-pkg && npm run test-units
 *
 * Runs against the BUILT dist/.
 */
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.join(here, '..', 'dist', 'run-samples.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-run-samples: dist/run-samples.js is missing; build first.',
  );
  process.exit(1);
}
const {summarizeSamples, samplesSection} = await import(
  pathToFileURL(built).href
);

const series = (n, f) => Array.from({length: n}, (_, i) => f(i * 2));

test('a flat, quiet page raises no flag', () => {
  const s = summarizeSamples(series(100, t => ({t_s: t, heap_mb: 50, xhr: 3})));
  assert.deepEqual(s.flags, []);
  assert.equal(s.maxRiseMBPerS, 0);
  assert.equal(s.requests, 3);
});

test('heap rising with no requests is flagged', () => {
  const s = summarizeSamples(
    series(40, t => ({t_s: t, heap_mb: 50 + 2 * t, xhr: 5})),
  );
  assert.equal(s.flags.length, 1);
  assert.match(s.flags[0], /^HEAP RISING WITH NO REQUESTS: \+2\.0 MB\/s/);
});

test('a request storm in the last minute is flagged', () => {
  // 1 request a minute for 2 minutes, then 10 a second.
  const s = summarizeSamples(
    series(120, t => ({
      t_s: t,
      heap_mb: 50,
      xhr: t < 120 ? Math.floor(t / 60) : 2 + (t - 120) * 10,
    })),
  );
  assert.ok(
    s.flags.some(f => f.startsWith('REQUEST RATE: 600/min')),
    s.flags,
  );
});

test('counters that reset on a reload are summed per document', () => {
  const s = summarizeSamples([
    {t_s: 0, heap_mb: 10, xhr: 4},
    {t_s: 2, heap_mb: 10, xhr: 9},
    {t_s: 4, heap_mb: 8, xhr: 1, reloaded: true},
    {t_s: 6, heap_mb: 8, xhr: 3},
    {t_s: 8, error: 'socket closed'},
  ]);
  assert.equal(s.requests, 12);
  assert.equal(s.reloads, 1);
  assert.equal(s.failedSamples, 1);
});

test('a reload in the last minute does not hide a request storm', () => {
  // 1 request a minute, then 10 a second; the page reloads at 200s.
  const s = summarizeSamples(
    series(120, t => ({
      t_s: t,
      heap_mb: 50,
      reloaded: t === 200,
      xhr:
        t < 120
          ? Math.floor(t / 60)
          : t < 200
            ? 2 + (t - 120) * 10
            : (t - 200) * 10,
    })),
  );
  assert.ok(
    s.flags.some(f => f.startsWith('REQUEST RATE: 580/min')),
    s.flags,
  );
});

test('every window of 30s or more is checked, not only the first', () => {
  const s = summarizeSamples([
    {t_s: 0, heap_mb: 50},
    {t_s: 30, heap_mb: 50},
    {t_s: 45, heap_mb: 110},
  ]);
  assert.ok(Math.abs(s.maxRiseMBPerS - 60 / 45) < 1e-9, s.maxRiseMBPerS);
  assert.equal(s.flags.length, 1);
  assert.match(s.flags[0], /^HEAP RISING WITH NO REQUESTS: \+1\.3 MB\/s/);
});

test('a reload between equal endpoints is not a quiet rise', () => {
  const flagged = summarizeSamples([
    {t_s: 0, heap_mb: 50, xhr: 5},
    {t_s: 15, heap_mb: 80, xhr: 0, reloaded: true},
    {t_s: 30, heap_mb: 110, xhr: 5},
  ]);
  assert.deepEqual(flagged.flags, []);
  const reset = summarizeSamples([
    {t_s: 0, heap_mb: 50, fetch: 5},
    {t_s: 15, heap_mb: 80, fetch: 2},
    {t_s: 30, heap_mb: 110, fetch: 5},
  ]);
  assert.deepEqual(reset.flags, []);
});

test('top paths are merged across reloads', () => {
  const s = summarizeSamples([
    {t_s: 0, xhr: 50, top_paths: [['/storm', 50]]},
    {t_s: 2, xhr: 1, reloaded: true, top_paths: [['/home', 1]]},
    {
      t_s: 4,
      xhr: 3,
      top_paths: [
        ['/storm', 2],
        ['/home', 1],
      ],
    },
  ]);
  assert.deepEqual(s.topPaths, [
    ['/storm', 52],
    ['/home', 1],
  ]);
});

test('samplesSection reads samples.jsonl and leads with the runaway', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-samples-'));
  assert.equal(samplesSection(dir, null), null);
  fs.writeFileSync(
    path.join(dir, 'samples.jsonl'),
    '{"t_s": 0, "heap_mb": 10}\n{"t_s": 2, "heap_mb": 12}\n{"t_s": 4, "he',
  );
  const lines = samplesSection(dir, 'heap 300 MB passed baseline 10 + 200 MB');
  assert.equal(lines[0], '### Between rungs (samples.jsonl)');
  assert.match(lines[2], /^2 samples over 2s: heap 10\.0 MB → max 12\.0 MB/);
  assert.equal(
    lines[4],
    '- ⚠ **RUNAWAY: heap 300 MB passed baseline 10 + 200 MB**',
  );
  fs.rmSync(dir, {recursive: true});
});
