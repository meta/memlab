/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import type {ScriptCensus} from '../../../lib/heap/ScriptCensus';

import vm from 'vm';
import {config, dumpNodeHeapSnapshot, utils} from '@memlab/core';
import {
  censusScripts,
  getScriptGroupKey,
  getScriptUrl,
} from '../../../lib/heap/ScriptCensus';

const timeout = 5 * 60 * 1000;

const BUNDLE_URL = 'memlab-test://bundle.js';
const OTHER_URL = 'memlab-test://other.js';

// retained until the snapshot is taken
const kept: Array<() => number> = [];
let census: ScriptCensus;

function load(source: string, filename: string): () => number {
  return vm.runInThisContext(source, {filename}) as () => number;
}

beforeAll(async () => {
  config.isTest = true;
  // two builds of one bundle, each copy kept alive by a function
  kept.push(
    load(`(function () { return 1; }) /* ${'x'.repeat(100000)} */`, BUNDLE_URL),
  );
  kept.push(
    load(
      `(function () { return 2; }) /* ${'y'.repeat(100000)} */`,
      `${BUNDLE_URL}?v=2`,
    ),
  );
  kept.push(load('(function () { return 3; })', OTHER_URL));
  const snapshot = await utils.getSnapshotFromFile(dumpNodeHeapSnapshot(), {});
  census = censusScripts(snapshot);
}, timeout);

test('groups scripts by URL and counts each copy of the source', () => {
  const bundle = census.groups.find(g => g.key === BUNDLE_URL);
  expect(bundle).toMatchObject({hasUrl: true, scripts: 2, sources: 2});
  expect(bundle?.sourceBytes).toBeGreaterThan(200000);
  // every copy but the largest
  expect(bundle?.duplicateBytes).toBeGreaterThan(100000);
  expect(bundle?.duplicateBytes).toBeLessThan(bundle?.sourceBytes ?? 0);

  const other = census.groups.find(g => g.key === OTHER_URL);
  expect(other).toMatchObject({scripts: 1, sources: 1, duplicateBytes: 0});
});

test('lists duplicated scripts first and keeps totals consistent', () => {
  expect(census.groups[0].key).toBe(BUNDLE_URL);
  const bytes = census.groups.reduce((sum, g) => sum + g.sourceBytes, 0);
  expect(bytes).toBe(census.totalSourceBytes);
  const scripts = census.groups.reduce((sum, g) => sum + g.scripts, 0);
  expect(scripts).toBe(census.scriptCount);
  expect(census.totalSourceBytes).toBeLessThan(census.totalHeapBytes);
});

test('reads the URL from both forms of Script node name', () => {
  const node = (type: string, name: string) =>
    ({type, name}) as unknown as IHeapNode;
  expect(
    getScriptUrl(node('code', 'system / Script / https://a.com/x.js')),
  ).toBe('https://a.com/x.js');
  expect(getScriptUrl(node('code', 'system / Script / '))).toBe('');
  expect(getScriptUrl(node('code', 'system / Script'))).toBe('');
  expect(getScriptUrl(node('code', 'node:internal/errors'))).toBe(
    'node:internal/errors',
  );
});

test('groups URLs that differ only in query string or fragment', () => {
  expect(getScriptGroupKey('https://a.com/app.js?v=2')).toBe(
    'https://a.com/app.js',
  );
  expect(getScriptGroupKey('https://a.com/app.js#x')).toBe(
    'https://a.com/app.js',
  );
  expect(getScriptGroupKey('node:events')).toBe('node:events');
});

test('ignores code nodes without a source', () => {
  const empty = censusScripts({
    nodes: {
      forEach: (cb: (n: IHeapNode) => void) =>
        cb({
          type: 'code',
          name: '(builtin code)',
          self_size: 88,
          references: [],
        } as unknown as IHeapNode),
    },
  } as unknown as IHeapSnapshot);
  expect(empty).toMatchObject({scriptCount: 0, totalHeapBytes: 88});
});
