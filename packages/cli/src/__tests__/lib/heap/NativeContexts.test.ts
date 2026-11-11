/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapSnapshot} from '@memlab/core';
import type {NativeContextAttribution} from '../../../lib/heap/NativeContexts';

import vm from 'vm';
import {config, dumpNodeHeapSnapshot, utils} from '@memlab/core';
import {
  attributeNativeContexts,
  isNativeContext,
  SHARED,
  UNATTRIBUTED,
} from '../../../lib/heap/NativeContexts';

const timeout = 5 * 60 * 1000;

// retained until the snapshot is taken
let sandbox: vm.Context;
let snapshot: IHeapSnapshot;
let attribution: NativeContextAttribution;

beforeAll(async () => {
  config.isTest = true;
  sandbox = vm.createContext({});
  vm.runInContext(
    `class MemlabRealmProbe { constructor(i) { this.label = 'probe ' + i; } }
     globalThis.probes = Array.from({length: 5000}, (_, i) => new MemlabRealmProbe(i));`,
    sandbox,
  );
  snapshot = await utils.getSnapshotFromFile(dumpNodeHeapSnapshot(), {});
  attribution = attributeNativeContexts(snapshot);
}, timeout);

test('recognizes NativeContext node names', () => {
  expect(isNativeContext('system / NativeContext')).toBe(true);
  expect(isNativeContext('system / NativeContext / https://a.com')).toBe(true);
  expect(isNativeContext('Detached system / NativeContext / about:blank')).toBe(
    true,
  );
  expect(isNativeContext('system / NativeContextFoo')).toBe(false);
  expect(isNativeContext('Window')).toBe(false);
});

test('gives a vm context the objects created in it', () => {
  expect(sandbox).toBeDefined();
  expect(attribution.contexts.length).toBeGreaterThanOrEqual(2);
  let probeOwner: number | null = null;
  let probes = 0;
  snapshot.nodes.forEach(node => {
    if (node.type === 'object' && node.name === 'MemlabRealmProbe') {
      probes++;
      const owner = attribution.owner[node.nodeIndex];
      probeOwner = probeOwner ?? owner;
      expect(owner).toBe(probeOwner);
    }
  });
  expect(probes).toBe(5000);
  expect(probeOwner).not.toBe(SHARED);
  expect(probeOwner).not.toBe(UNATTRIBUTED);
  const realm = attribution.contexts.find(c => c.ordinal === probeOwner);
  expect(realm?.ownedCount).toBeGreaterThanOrEqual(5000);
});

test('accounts for every node exactly once', () => {
  const owned = attribution.contexts.reduce((n, c) => n + c.ownedCount, 0);
  expect(owned + attribution.sharedCount + attribution.unattributedCount).toBe(
    snapshot.nodes.length,
  );
  let selfTotal = 0;
  snapshot.nodes.forEach(node => {
    selfTotal += node.self_size;
  });
  const ownedSize = attribution.contexts.reduce((n, c) => n + c.ownedSize, 0);
  expect(
    ownedSize + attribution.sharedSize + attribution.unattributedSize,
  ).toBe(selfTotal);
  const sizes = attribution.contexts.map(c => c.ownedSize);
  expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
});
