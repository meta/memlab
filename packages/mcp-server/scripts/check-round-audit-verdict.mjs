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
 * Unit tests for the round audit verdict (tools/round-audit.ts): the reload
 * between A/B arms is not a ladder split, and a caveat unchanged since an
 * earlier round of the sweep does not decide this round's verdict.
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
const dist = path.join(here, '..', 'dist');
if (!fs.existsSync(path.join(dist, 'tools', 'round-audit.js'))) {
  console.error(
    'check-round-audit-verdict: dist/tools/round-audit.js is missing; build first.',
  );
  process.exit(1);
}
const {auditManifest, withStanding} = await import(
  pathToFileURL(path.join(dist, 'tools', 'round-audit.js')).href
);

const rung = (index, extra = {}) => ({
  index,
  path: `/nonexistent/rung_${index}.heapsnapshot`,
  ...extra,
});
const base = () => ({
  rungs: [0, 1, 2, 3, 4, 5].map(i => rung(i)),
  steps: {open: {attempted: 10, landed: 10, rate: 1}},
  gating_summary: {declared: 1, verified: 1, absent: 0},
  totals: {cycles: 60, ok: 60},
});
const ab = () => ({
  ...base(),
  rungs: [0, 1, 2, 3, rung(4, {isolate_restarted: true}), 5, 6, 7].map(r =>
    typeof r === 'number' ? rung(r) : r,
  ),
  ladder_splits_after_rung: [3],
  ab: {
    off: {prop: 'p', rungs: [0, 1, 2, 3], cycles: 30},
    on: {prop: 'p', rungs: [4, 5, 6, 7], cycles: 30},
  },
  caveats: [
    'LADDER SPLIT: the page reloaded between rung 3 and rung 4 (longtasks 9 -> 1).',
  ],
});
const status = (audit, name) => audit.checks.find(c => c.name === name)?.status;

test('the reload between A/B arms is not a split', () => {
  const audit = auditManifest(ab());
  assert.equal(status(audit, 'ladder continuity'), 'ok');
  assert.match(
    audit.checks.find(c => c.name === 'ladder continuity').detail,
    /2 segments \(A\/B arms: OFF rungs 0–3, ON rungs 4–7\), each continuous/,
  );
  assert.equal(status(audit, 'A/B arms'), 'ok');
  assert.equal(status(audit, 'recorded caveats'), undefined);
  assert.equal(audit.verdict, 'TRUSTWORTHY');
});

test('a reload inside an arm still blocks', () => {
  const m = ab();
  m.ladder_splits_after_rung = [3, 5];
  assert.equal(status(auditManifest(m), 'ladder continuity'), 'blocking');
});

test('a broken arm blocks', () => {
  const m = ab();
  m.ab.on = {prop: 'p', rungs: [4], cycles: 0};
  const audit = auditManifest(m);
  assert.equal(status(audit, 'A/B arms'), 'blocking');
  assert.equal(audit.verdict, 'UNTRUSTWORTHY');
  const missing = ab();
  delete missing.ab.on;
  assert.equal(status(auditManifest(missing), 'A/B arms'), 'blocking');
});

test('an OFF → ON → OFF round checks both reloads and all three arms', () => {
  const m = ab();
  m.rungs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(i =>
    rung(i, i === 4 || i === 8 ? {isolate_restarted: true} : {}),
  );
  m.ladder_splits_after_rung = [3, 7];
  m.ab.off2 = {prop: 'p', rungs: [8, 9, 10, 11], cycles: 30};
  m.caveats.push(
    'LADDER SPLIT: the page reloaded between rung 7 and rung 8 (longtasks 9 -> 1).',
  );
  const audit = auditManifest(m);
  assert.equal(status(audit, 'ladder continuity'), 'ok');
  assert.match(
    audit.checks.find(c => c.name === 'ladder continuity').detail,
    /3 segments \(A\/B arms: OFF rungs 0–3, ON rungs 4–7, OFF again rungs 8–11\)/,
  );
  assert.match(
    audit.checks.find(c => c.name === 'A/B arms').detail,
    /All three/,
  );
  assert.equal(audit.verdict, 'TRUSTWORTHY');
  m.ab.off2 = {prop: 'p', rungs: [8], cycles: 5};
  assert.equal(status(auditManifest(m), 'A/B arms'), 'blocking');
});

test('a non-A/B round with `ab: {}` is judged as one ladder', () => {
  const m = {...base(), ab: {}, ladder_splits_after_rung: [2]};
  const audit = auditManifest(m);
  assert.equal(status(audit, 'A/B arms'), undefined);
  assert.equal(status(audit, 'ladder continuity'), 'blocking');
});

test('a request fault that matched nothing blocks', () => {
  const m = {
    ...base(),
    faults: {
      kinds: ['hidden', 'xhr-fail'],
      failed_requests: 0,
      matched_requests: {'xhr-fail': 0},
      xhr_patterns: ['*/ajax/bootloader-endpoint/*'],
    },
  };
  const audit = auditManifest(m);
  assert.equal(status(audit, 'faults'), 'blocking');
  assert.match(
    audit.checks.find(c => c.name === 'faults').detail,
    /fault xhr-fail matched 0 requests \(xhr pattern `\*\/ajax\/bootloader-endpoint\/\*`\)/,
  );
  assert.equal(audit.verdict, 'UNTRUSTWORTHY');
  m.faults.matched_requests = {'xhr-fail': 76};
  assert.equal(status(auditManifest(m), 'faults'), 'ok');
  // An older round: only the total.
  const old = {...base(), faults: {kinds: ['xhr-fail'], failed_requests: 0}};
  assert.equal(status(auditManifest(old), 'faults'), 'blocking');
  const hidden = {...base(), faults: {kinds: ['hidden'], failed_requests: 0}};
  assert.equal(status(auditManifest(hidden), 'faults'), undefined);
});

function sweep(rounds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-standing-'));
  for (const [name, m] of Object.entries(rounds)) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(
      path.join(dir, name, 'run.json'),
      JSON.stringify({run_id: name, ...m}),
    );
  }
  return dir;
}

const warm = {isolate_age_at_baseline: {ms_since_navigation: 400_000}};
const DEAD = 'DEAD PROP: web_x is read by no served code';

test('standing caveats do not decide the verdict', () => {
  const dir = sweep({
    r9: {...base(), ...warm, caveats: [DEAD]},
    r10: {...base(), ...warm, caveats: [DEAD]},
    r11: {...base(), ...warm, caveats: [DEAD]},
  });
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'r11', 'run.json')));
  const plain = auditManifest(m);
  assert.equal(plain.verdict, 'CAVEATED');
  const s = withStanding(path.join(dir, 'r11'), m, plain);
  assert.equal(s.verdict, 'TRUSTWORTHY');
  assert.deepEqual(s.standingCaveats, [{text: DEAD, since: 'r9'}]);
  assert.deepEqual(s.roundCaveats, []);
  assert.equal(status(s, 'baseline isolate age'), 'info');
  assert.match(
    s.checks.find(c => c.name === 'baseline isolate age').detail,
    /unchanged since r9/,
  );
});

test('a caveat new in this round still decides it', () => {
  const dir = sweep({
    r9: {...base(), caveats: [DEAD]},
    r10: {...base(), ...warm, caveats: [DEAD, 'something new']},
  });
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'r10', 'run.json')));
  const s = withStanding(path.join(dir, 'r10'), m, auditManifest(m));
  assert.equal(s.verdict, 'CAVEATED');
  assert.deepEqual(s.roundCaveats, ['something new']);
  assert.equal(status(s, 'baseline isolate age'), 'caveat');
  assert.match(
    s.checks.find(c => c.name === 'recorded caveats').detail,
    /1 caveat\(s\) specific to this round .*1 more unchanged since r9/,
  );
});

test('a round-quality caveat is never standing', () => {
  const weak = {
    ...base(),
    steps: {open: {attempted: 10, landed: 2, rate: 0.2}},
  };
  const dir = sweep({r1: weak, r2: weak});
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'r2', 'run.json')));
  const s = withStanding(path.join(dir, 'r2'), m, auditManifest(m));
  assert.equal(status(s, 'per-step landing'), 'caveat');
  assert.equal(s.verdict, 'CAVEATED');
});

test('a standing check must match the earlier detail, not just its name', () => {
  const absent = (...props) => ({
    gating_summary: {
      declared: 2,
      verified: 2 - props.length,
      absent: props.length,
      absent_props: props,
    },
  });
  const dir = sweep({
    r9: {...base(), ...absent('web_x'), ...warm},
    r10: {
      ...base(),
      ...absent('web_y'),
      isolate_age_at_baseline: {ms_since_navigation: 900_000},
    },
  });
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'r10', 'run.json')));
  const s = withStanding(path.join(dir, 'r10'), m, auditManifest(m));
  assert.equal(status(s, 'gating'), 'caveat');
  assert.equal(s.verdict, 'CAVEATED');
  // An older warm isolate is the same caveat.
  assert.equal(status(s, 'baseline isolate age'), 'info');
});
