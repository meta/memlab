/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode} from '../../lib/Types';
import {NodeRecord} from '../../trace-cluster/TraceElement';

function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return '';
}

test('every unsupported NodeRecord member names itself in its error', () => {
  const record = new NodeRecord({
    name: 'LeakedObject',
    type: 'object',
    id: 1,
  } as IHeapNode);
  // these two read the `numOfReferrers` stub, so they throw its error
  const delegating = new Set(['getJSONifyableObject', 'toJSONString']);
  const descriptors = Object.getOwnPropertyDescriptors(NodeRecord.prototype);
  let checked = 0;
  for (const [name, d] of Object.entries(descriptors)) {
    if (delegating.has(name)) {
      continue;
    }
    const accessors: Array<() => unknown> = [];
    if (d.get) {
      accessors.push(() => d.get?.call(record));
    }
    if (d.set) {
      accessors.push(() => d.set?.call(record, null));
    }
    if (typeof d.value === 'function' && name !== 'constructor') {
      accessors.push(() => d.value.call(record));
    }
    for (const access of accessors) {
      const message = errorOf(access);
      // only the stubs throw a `NodeRecord.` error
      if (!message.startsWith('NodeRecord.')) {
        continue;
      }
      expect(message).toMatch(new RegExp(`^NodeRecord\\.${name} `));
      ++checked;
    }
  }
  // the stubs for references, referrers, pathEdge, dominatorNode, ...
  expect(checked).toBeGreaterThan(20);
});
