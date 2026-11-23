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
 * Unit tests for the session rung cache bookkeeping (heap-state.ts): cached
 * rungs are found by path but not listed as resident, a rewritten file is
 * not served from the cache, and a cached rung the user switches to is theirs.
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
if (!fs.existsSync(path.join(dist, 'heap-state.js'))) {
  console.error(
    'check-session-rung-cache: dist/heap-state.js is missing; build first.',
  );
  process.exit(1);
}
const hs = await import(pathToFileURL(path.join(dist, 'heap-state.js')).href);
const {withRungLine} = await import(
  pathToFileURL(path.join(dist, 'guardrail.js')).href
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rung-cache-'));
const file = name => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x');
  return p;
};
const meta = name => ({
  fileName: name,
  nodeCount: 1,
  edgeCount: 0,
  totalSize: 0,
  env: 'browser',
});

test('a cached rung is found by path but not listed', () => {
  hs.clearAllSnapshots();
  const mine = file('mine.heapsnapshot');
  const rung = file('rung_01.heapsnapshot');
  const a = hs.setSnapshot({}, mine, meta('mine.heapsnapshot'));
  const b = hs.setSnapshot({}, rung, meta('rung_01.heapsnapshot'), {
    replace: false,
  });
  hs.restoreCurrentHandle(a.handle);
  hs.setCachedHandle(b.handle, true);
  assert.deepEqual(
    hs.listSnapshots().map(m => m.handle),
    [a.handle],
  );
  assert.equal(hs.listSnapshots({includeCached: true}).length, 2);
  assert.equal(hs.findResidentByPath(rung)?.handle, b.handle);
});

test('a rewritten rung file is not served from the cache', () => {
  hs.clearAllSnapshots();
  const rung = file('rung_02.heapsnapshot');
  const a = hs.setSnapshot({}, file('cur.heapsnapshot'), meta('cur'));
  const b = hs.setSnapshot({}, rung, meta('rung_02'), {replace: false});
  hs.restoreCurrentHandle(a.handle);
  hs.setCachedHandle(b.handle, true);
  fs.writeFileSync(rung, 'a different, longer capture');
  assert.equal(hs.findResidentByPath(rung), null);
  assert.equal(hs.getMetadataByHandle(b.handle), null);
});

test('switching to a cached rung makes it a listed snapshot', () => {
  hs.clearAllSnapshots();
  const a = hs.setSnapshot({}, file('one.heapsnapshot'), meta('one'));
  const b = hs.setSnapshot({}, file('two.heapsnapshot'), meta('two'), {
    replace: false,
  });
  hs.restoreCurrentHandle(a.handle);
  hs.setCachedHandle(b.handle, true);
  hs.setCurrentSnapshot(b.handle);
  hs.setCurrentSnapshot(a.handle);
  assert.equal(hs.listSnapshots().length, 2);
});

test('removing the active snapshot never falls back to a cached rung', () => {
  hs.clearAllSnapshots();
  const a = hs.setSnapshot({}, file('p.heapsnapshot'), meta('p'));
  const b = hs.setSnapshot({}, file('q.heapsnapshot'), meta('q'), {
    replace: false,
  });
  const c = hs.setSnapshot({}, file('r.heapsnapshot'), meta('r'), {
    replace: false,
  });
  hs.restoreCurrentHandle(a.handle);
  hs.setCachedHandle(b.handle, true);
  hs.removeSnapshot(a.handle);
  assert.equal(hs.getCurrentHandle(), c.handle);
});

test('a result that read rungs says how many were cached', () => {
  const r = withRungLine({content: [{type: 'text', text: 'done'}]}, 1, 3);
  assert.equal(r.content[0].text, 'done\n\n_rungs: 3 cached / 1 parsed_');
  const none = {content: [{type: 'text', text: 'done'}]};
  assert.equal(withRungLine(none, 0, 0), none);
});
