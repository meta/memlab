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

import {config, dumpNodeHeapSnapshot, utils} from '@memlab/core';
import {
  auditDom,
  describeElement,
  isAttachedElement,
} from '../../../lib/heap/DomAudit';

const timeout = 5 * 60 * 1000;

beforeEach(() => {
  config.isTest = true;
});

function fakeSnapshot(nodes: Array<[string, string, number]>): IHeapSnapshot {
  return {
    nodes: {
      forEach: (callback: (node: IHeapNode) => void) =>
        nodes.forEach(([type, name, size]) =>
          callback({type, name, self_size: size} as IHeapNode),
        ),
    },
  } as unknown as IHeapSnapshot;
}

test('tells attached elements from everything else', () => {
  expect(isAttachedElement({type: 'native', name: '<div class="a">'})).toBe(
    true,
  );
  expect(isAttachedElement({type: 'native', name: 'SVGPathElement'})).toBe(
    true,
  );
  expect(isAttachedElement({type: 'native', name: 'Detached <div>'})).toBe(
    false,
  );
  expect(isAttachedElement({type: 'native', name: 'blink::Node'})).toBe(false);
  expect(isAttachedElement({type: 'string', name: '<div>'})).toBe(false);
});

test('describes an element by tag, test id and classes', () => {
  expect(describeElement('<li class="row  selected" id="x">')).toEqual({
    tag: 'li',
    signature: 'li.row.selected',
  });
  expect(describeElement('<div class="cell" data-testid="chat-row">')).toEqual({
    tag: 'div',
    signature: 'div[data-testid="chat-row"]',
  });
  expect(describeElement('<SPAN>')).toEqual({tag: 'span', signature: 'span'});
  expect(describeElement('SVGPathElement')).toEqual({
    tag: 'svg:path',
    signature: 'svg:path',
  });
  expect(describeElement('SVGElement')).toEqual({
    tag: 'svg:svg',
    signature: 'svg:svg',
  });
});

test('counts by tag and lists repeated rendered elements', () => {
  const nodes: Array<[string, string, number]> = [
    ['native', '<ul class="list">', 100],
    ['native', 'Detached <li class="row">', 50],
    ['native', 'blink::ComputedStyle', 200],
    ['native', 'blink::NodeRareData', 40],
    ['object', 'Object', 16],
  ];
  for (let i = 0; i < 25; i++) {
    nodes.push(['native', '<li class="row">', 60]);
    nodes.push(['native', 'SVGPathElement', 30]);
    nodes.push(['native', '<script src="x.js">', 10]);
  }
  const audit = auditDom(fakeSnapshot(nodes), 20);
  expect(audit).toMatchObject({
    attached: 76,
    attachedSelfSize: 100 + 25 * (60 + 30 + 10),
    detached: 1,
    sideDataCount: 2,
    sideDataSize: 240,
  });
  expect(audit.byTag.map(b => [b.key, b.count])).toEqual([
    ['li', 25],
    ['svg:path', 25],
    ['script', 25],
    ['ul', 1],
  ]);
  // scripts are not rendered, and the single <ul> is below the threshold
  expect(audit.repeated.map(b => [b.key, b.count])).toEqual([
    ['li.row', 25],
    ['svg:path', 25],
  ]);
});

test(
  'finds no attached elements in a Node.js heap',
  async () => {
    const snapshot = await utils.getSnapshotFromFile(
      dumpNodeHeapSnapshot(),
      {},
    );
    expect(auditDom(snapshot, 20)).toMatchObject({
      attached: 0,
      detached: 0,
      repeated: [],
    });
  },
  timeout,
);
