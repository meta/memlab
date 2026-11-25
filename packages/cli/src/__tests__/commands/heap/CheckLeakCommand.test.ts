/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {execFileSync, spawnSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const snapshotFiles = [
  '01-Heap-baseline.heapsnapshot',
  '02-Heap-target.heapsnapshot',
  '03-Heap-final.heapsnapshot',
];
const curDataDir = path.join('memlab', 'data', 'cur');
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlab-find-leaks-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function writeSnapshots(dir: string, files: string[]): void {
  fs.mkdirSync(dir, {recursive: true});
  execFileSync(
    process.execPath,
    [
      '-e',
      'const {writeHeapSnapshot} = require("v8"); ' +
        'for (const file of process.argv.slice(1)) writeHeapSnapshot(file);',
      ...files,
    ],
    {cwd: dir},
  );
}

function runCLI(...args: string[]) {
  const {status, stderr} = spawnSync(
    process.execPath,
    [path.join(__dirname, '../../../runner.js'), ...args],
    {
      cwd: tmpDir,
      encoding: 'utf8',
      env: {...process.env, TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir},
    },
  );
  const parsedFiles = [
    ...stderr.matchAll(/parsing (.*\.heapsnapshot) \.\.\./g),
  ].map(([, file]) => path.basename(file));
  return {status, parsedFiles};
}

test.each([
  ['snapshots', snapshotFiles],
  [curDataDir, snapshotFiles],
  ['numbered', ['s1.heapsnapshot', 's2.heapsnapshot', 's10.heapsnapshot']],
])(
  'find-leaks reads snapshots in filename order from %s without a manifest',
  (dir, files) => {
    writeSnapshots(path.join(tmpDir, dir), [...files].reverse());

    expect(runCLI('find-leaks', '--snapshot-dir', dir)).toEqual({
      status: 0,
      parsedFiles: files,
    });
  },
);

test('find-leaks uses explicit snapshot paths with a stale work directory manifest', () => {
  writeSnapshots(path.join(tmpDir, 'snapshots'), snapshotFiles);
  const dataDir = path.join(tmpDir, curDataDir);
  fs.mkdirSync(dataDir, {recursive: true});
  fs.writeFileSync(
    path.join(dataDir, 'snap-seq.json'),
    JSON.stringify([
      {
        idx: 1,
        name: 'target',
        type: 'target',
        snapshot: true,
        snapshotFile: 'old.heapsnapshot',
      },
      {
        idx: 2,
        name: 'final',
        type: 'final',
        snapshot: true,
        snapshotFile: 'old.heapsnapshot',
      },
    ]),
  );

  expect(
    runCLI(
      'find-leaks',
      '--baseline',
      path.join('snapshots', snapshotFiles[0]),
      '--target',
      path.join('snapshots', snapshotFiles[1]),
      '--final',
      path.join('snapshots', snapshotFiles[2]),
    ),
  ).toEqual({status: 0, parsedFiles: snapshotFiles});
});

test('find-leaks discovers a replacement snapshot after run data is cleared', () => {
  const dataDir = path.join(tmpDir, curDataDir);
  const old = 'old.heapsnapshot';
  const replacement = 'replacement.heapsnapshot';
  writeSnapshots(dataDir, [old]);
  expect(runCLI('find-leaks')).toEqual({
    status: 0,
    parsedFiles: [old, old],
  });

  expect(runCLI('clear-run-data').status).toBe(0);
  writeSnapshots(dataDir, [replacement]);

  expect(runCLI('find-leaks')).toEqual({
    status: 0,
    parsedFiles: [replacement, replacement],
  });
});
