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
 * not served from the cache or from a load, and a cached rung the user
 * switches to is theirs.
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
import v8 from 'v8';

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
const {withSnapshotAt} = await import(
  pathToFileURL(path.join(dist, 'snapshot-borrow.js')).href
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

test('a loaded snapshot whose file was rewritten is kept, not served', () => {
  hs.clearAllSnapshots();
  const rung = file('after.heapsnapshot');
  const a = hs.setSnapshot({}, rung, meta('after'));
  fs.writeFileSync(rung, 'the capture taken after the fix');
  assert.equal(hs.findResidentByPath(rung), null);
  assert.equal(hs.getMetadataByHandle(a.handle)?.handle, a.handle);
  const b = hs.setSnapshot({}, rung, meta('after'), {replace: false});
  assert.equal(hs.findResidentByPath(rung)?.handle, b.handle);
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

test('with only cached rungs left, no snapshot is active', () => {
  hs.clearAllSnapshots();
  const a = hs.setSnapshot({}, file('only.heapsnapshot'), meta('only'));
  const b = hs.setSnapshot({}, file('kept.heapsnapshot'), meta('kept'), {
    replace: false,
  });
  hs.restoreCurrentHandle(a.handle);
  hs.setCachedHandle(b.handle, true);
  hs.removeSnapshot(a.handle);
  assert.equal(hs.getCurrentHandle(), null);
});

test('a stat taken before the parse is the one recorded', () => {
  hs.clearAllSnapshots();
  const p = file('early.heapsnapshot');
  const early = {size: 1, mtimeMs: 1};
  const m = hs.setSnapshot({}, p, {...meta('early'), fileStat: early});
  assert.deepEqual(m.fileStat, early);
});

test('a rung pinned by another call is kept, and evicted once released', async () => {
  hs.clearAllSnapshots();
  const prev = process.env.MEMLAB_SESSION_RUNGS;
  process.env.MEMLAB_SESSION_RUNGS = '1';
  try {
    const snap = name => v8.writeHeapSnapshot(path.join(dir, name));
    const [a, b, c] = ['a', 'b', 'c'].map(n => snap(`${n}.heapsnapshot`));
    await withSnapshotAt(a, () => null);
    const ha = hs.findResidentByPath(a).handle;
    hs.pinHandle(ha);
    // Another call borrows `b` while this one ends.
    let hb = null;
    await withSnapshotAt(b, () => {
      hb = hs.findResidentByPath(b).handle;
      hs.pinHandle(hb);
    });
    assert.notEqual(hs.getMetadataByHandle(ha), null);
    assert.notEqual(hs.getMetadataByHandle(hb), null);
    hs.unpinHandle(ha);
    hs.unpinHandle(hb);
    await withSnapshotAt(c, () => null);
    assert.equal(hs.getMetadataByHandle(ha), null);
    assert.equal(hs.getMetadataByHandle(hb), null);
  } finally {
    if (prev == null) {
      delete process.env.MEMLAB_SESSION_RUNGS;
    } else {
      process.env.MEMLAB_SESSION_RUNGS = prev;
    }
  }
});

test('a result that read rungs says how many were cached', () => {
  const r = withRungLine({content: [{type: 'text', text: 'done'}]}, 1, 3);
  assert.equal(r.content[0].text, 'done\n\n_rungs: 3 cached / 1 parsed_');
  const none = {content: [{type: 'text', text: 'done'}]};
  assert.equal(withRungLine(none, 0, 0), none);
});

test('pinned rungs count against the cap, so an unpinned one is evicted', async () => {
  hs.clearAllSnapshots();
  const prev = process.env.MEMLAB_SESSION_RUNGS;
  process.env.MEMLAB_SESSION_RUNGS = '1';
  const pinned = [];
  try {
    const snap = name => v8.writeHeapSnapshot(path.join(dir, name));
    const [a, b, c] = ['pa', 'pb', 'pc'].map(n => snap(`${n}.heapsnapshot`));
    await withSnapshotAt(a, () => null);
    pinned.push(hs.findResidentByPath(a).handle);
    hs.pinHandle(pinned[0]);
    await withSnapshotAt(b, () => {
      pinned.push(hs.findResidentByPath(b).handle);
      hs.pinHandle(pinned[1]);
    });
    await withSnapshotAt(c, () => null);
    assert.equal(hs.findResidentByPath(c), null);
    for (const h of pinned) {
      assert.notEqual(hs.getMetadataByHandle(h), null);
    }
  } finally {
    for (const h of pinned) {
      hs.unpinHandle(h);
    }
    if (prev == null) {
      delete process.env.MEMLAB_SESSION_RUNGS;
    } else {
      process.env.MEMLAB_SESSION_RUNGS = prev;
    }
  }
});
