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
 * Unit tests for the per-file size limit: `resolveMaxFileSizeMB` and
 * `fileSizeRefusal` (tools/load-snapshot.ts) with `withFileSizeLimit`
 * (file-size-scope.ts).
 *
 *   npm run build-pkg && npm run test-units
 *
 * Runs against the BUILT dist/.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
if (!fs.existsSync(path.join(dist, 'file-size-scope.js'))) {
  console.error('check-file-size-limit: dist/ is missing; build first.');
  process.exit(1);
}
const {withFileSizeLimit} = await import(
  pathToFileURL(path.join(dist, 'file-size-scope.js')).href
);
const {resolveMaxFileSizeMB, fileSizeRefusal} = await import(
  pathToFileURL(path.join(dist, 'tools', 'load-snapshot.js')).href
);

test('explicit, then the call scope, then the env var, then the default', () => {
  delete process.env.MEMLAB_MAX_FILE_SIZE_MB;
  const def = resolveMaxFileSizeMB(undefined, false);
  assert.ok(def >= 900);
  process.env.MEMLAB_MAX_FILE_SIZE_MB = '1500';
  assert.equal(resolveMaxFileSizeMB(undefined, false), 1500);
  withFileSizeLimit(3000, () => {
    assert.equal(resolveMaxFileSizeMB(undefined, false), 3000);
    assert.equal(resolveMaxFileSizeMB(200, false), 200);
  });
  delete process.env.MEMLAB_MAX_FILE_SIZE_MB;
  assert.equal(resolveMaxFileSizeMB(undefined, false), def);
});

test('a call scope survives awaits', async () => {
  await withFileSizeLimit(2500, async () => {
    await new Promise(r => setTimeout(r, 5));
    assert.equal(resolveMaxFileSizeMB(undefined, false), 2500);
  });
});

test('refusal text names the limit that applied', () => {
  assert.equal(fileSizeRefusal('a', '/nope/a', 10, undefined, false), null);
  const own = fileSizeRefusal('a', '/nope/a', 500, 100, false, 'memlab_x');
  assert.match(own, /over the max_file_size_mb of 100 MB passed to this call/);
  assert.match(own, /memlab_x\(\{max_file_size_mb: 600\}\)/);
  process.env.MEMLAB_MAX_FILE_SIZE_MB = '100';
  assert.match(
    fileSizeRefusal('a', '/nope/a', 500, undefined, false),
    /over MEMLAB_MAX_FILE_SIZE_MB/,
  );
  delete process.env.MEMLAB_MAX_FILE_SIZE_MB;
  assert.match(
    fileSizeRefusal('a', '/nope/a', 1e6, undefined, false),
    /per-file safety limit.*larger heap/,
  );
});
