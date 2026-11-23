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
 * Unit tests for tools/activity-report.ts: crediting sampled counters to the
 * label that was driving, and the per-rung request roll-up.
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
const built = path.join(here, '..', 'dist', 'tools', 'activity-report.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-activity-report: dist/tools/activity-report.js is missing; build first.',
  );
  process.exit(1);
}
const {
  parseSamples,
  activityByLabel,
  topRequests,
  activityFromRungWindows,
  registerActivityReport,
} = await import(pathToFileURL(built).href);

const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n');

test('increments are credited to the label of the later sample', () => {
  const acts = activityByLabel(
    parseSamples(
      jsonl([
        {t_s: 0, tag: 'a', xhr: 0, fetch: 0, time_origin: 1},
        {t_s: 10, tag: 'a', xhr: 5, fetch: 1, time_origin: 1},
        {t_s: 20, tag: 'b', xhr: 105, fetch: 1, error_ui: 1, time_origin: 1},
      ]),
    ),
  );
  const by = Object.fromEntries(acts.map(a => [a.label, a]));
  assert.equal(by.a.totals.requests, 6);
  assert.equal(by.b.totals.requests, 100);
  assert.equal(by.b.errorUiSeconds, 10);
  assert.equal(by.a.seconds, 10);
});

test('a reload resets counters without crediting a negative or a jump', () => {
  const acts = activityByLabel(
    parseSamples(
      jsonl([
        {t_s: 0, xhr: 50, time_origin: 1},
        {t_s: 5, xhr: 2, reloaded: true, time_origin: 2},
        {t_s: 10, xhr: 4, time_origin: 2},
        {t_s: 11, error: 'sample failed'},
      ]),
    ),
  );
  assert.equal(acts.length, 1);
  assert.equal(acts[0].totals.requests, 2);
  assert.equal(acts[0].seconds, 5);
});

test('other samplers: `t`, `res`, `resErr`, `longTaskMs`, `errUiNow`', () => {
  const [a] = activityByLabel(
    parseSamples(
      jsonl([
        {t: 100, tag: 'x', res: 1, resErr: 0, longTaskMs: 0, origin: 9},
        {
          t: 160,
          tag: 'x',
          res: 61,
          resErr: 3,
          longTaskMs: 500,
          errUiNow: 1,
          origin: 9,
        },
      ]),
    ),
  );
  assert.equal(a.totals.resources, 60);
  assert.equal(a.totals.resource_errors, 3);
  assert.equal(a.totals.long_task_ms, 500);
  assert.equal(a.errorUiSeconds, 60);
});

test('per-rung request windows roll up by path, with statuses', () => {
  const rows = topRequests(
    [
      {requests: {top: [{path: '/avatar', count: 3, status: {403: 3}}]}},
      {
        requests: {
          top: [
            {path: '/avatar', count: 2, status: {403: 1, 200: 1}},
            {path: '/a', count: 1, status: {200: 1}},
          ],
        },
      },
      {},
    ],
    5,
  );
  assert.deepEqual(rows[0], {
    path: '/avatar',
    count: 5,
    status: {403: 4, 200: 1},
  });
  assert.equal(rows.length, 2);
});

test('an idle control with no samples is read from its request windows', () => {
  const act = activityFromRungWindows([
    {requests: {total: 30, window_s: 60}},
    {requests: {total: 10, window_s: 60}},
    {requests: {error: 'unreadable'}},
    {},
  ]);
  assert.equal(act.seconds, 120);
  assert.equal(act.totals.resources, 40);
  assert.equal(act.totals.requests, 0);
  assert.equal(activityFromRungWindows([{}]), null);
});

test('with a windows-only control, a rejection loop still outranks a quiet row', async () => {
  let handler;
  registerActivityReport({tool: (...args) => (handler = args.at(-1))});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-'));
  const round = path.join(root, 'r1');
  const idle = path.join(root, 'r1-idle');
  fs.mkdirSync(round);
  fs.mkdirSync(idle);
  fs.writeFileSync(
    path.join(round, 'samples.jsonl'),
    jsonl([
      {t_s: 0, tag: 'quiet', res: 0, rejections: 0, time_origin: 1},
      {t_s: 60, tag: 'quiet', res: 30, rejections: 0, time_origin: 1},
      {t_s: 120, tag: 'rejecty', res: 60, rejections: 200, time_origin: 1},
    ]),
  );
  fs.writeFileSync(
    path.join(idle, 'run.json'),
    JSON.stringify({rungs: [{requests: {total: 30, window_s: 60}}]}),
  );
  const res = await handler({run_dir: round, limit: 10});
  const text = res.content[0].text;
  assert.match(text, /resources per minute only/);
  assert.ok(
    text.indexOf('| rejecty') < text.indexOf('| quiet'),
    text.slice(0, 1200),
  );
  fs.rmSync(root, {recursive: true, force: true});
});

test('an idle control on another build than the round is called out', async () => {
  const {controlBuildMismatch} = await import(
    pathToFileURL(path.join(here, '..', 'dist', 'tools', 'leak-report.js')).href
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-build-'));
  const round = (name, dev) => {
    const d = path.join(root, name);
    fs.mkdirSync(d);
    fs.writeFileSync(
      path.join(d, 'run.json'),
      JSON.stringify(dev == null ? {} : {environment: {dev_build: dev}}),
    );
    return d;
  };
  const dev = round('r1', true);
  const prod = round('idle-control', false);
  const dev2 = round('r2', true);
  const unknown = round('r3', null);
  assert.match(
    controlBuildMismatch(dev, prod),
    /ran a prod-like build and this round a dev build, .* overstate this round/,
  );
  const prodRound = round('r4', false);
  const devControl = round('idle-control-dev', true);
  const flipped = controlBuildMismatch(prodRound, devControl);
  assert.match(
    flipped,
    /ran a dev build and this round a prod-like build, .* understate this round/,
  );
  assert.doesNotMatch(flipped, /overstate/);
  assert.equal(controlBuildMismatch(dev, dev2), null);
  assert.equal(controlBuildMismatch(unknown, prod), null);
  fs.rmSync(root, {recursive: true});
});
