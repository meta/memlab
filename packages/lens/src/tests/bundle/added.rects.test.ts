/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import type {AnyValue} from '../../core/types';
import {test, expect} from '@playwright/test';
import {readLibBundle, wait} from '../utils/test-utils';

// 12,000 elements, more than the 5,000 whose rects are read per frame
const ELEMENT_COUNT = 12000;

test.beforeEach(async ({page}) => {
  await page.setContent(`<html><body><div id="root"></div>
    <script>${readLibBundle()}</script></body></html>`);
  await page.evaluate(() => {
    const w = window as AnyValue;
    w.scan = w.MemLens.createReactMemoryScan({scanIntervalMs: 60000});
    w.scan.start();
  });
});

async function addElements(page: AnyValue): Promise<void> {
  await page.evaluate((count: number) => {
    const container = document.createElement('div');
    container.id = 'container';
    for (let i = 0; i < count; ++i) {
      const span = document.createElement('span');
      span.style.cssText = 'display:inline-block;width:8px;height:8px';
      container.appendChild(span);
    }
    (document.getElementById('root') as HTMLElement).appendChild(container);
  }, ELEMENT_COUNT);
  // a few frames for the rects of the added elements
  await wait(500);
}

// every detached element is kept by the page, so no GC is needed
async function countRects(page: AnyValue) {
  return page.evaluate(() => {
    const w = window as AnyValue;
    w.scan.scan();
    const infos = w.scan.getDetachedDOMInfo({includeUnconfirmed: true});
    return {
      detached: infos.length,
      withRect: infos.filter((info: AnyValue) => info.boundingRect?.width > 0)
        .length,
    };
  });
}

test('every element of a large inserted subtree gets a rect', async ({
  page,
}) => {
  await addElements(page);
  // removed one by one, past the per-run removal rect budget, so most rely
  // on the rect read after they were added
  await page.evaluate(() => {
    const w = window as AnyValue;
    w.kept = Array.from(
      (document.getElementById('container') as HTMLElement).children,
    );
    for (const span of w.kept) {
      span.remove();
    }
  });
  await wait(100);
  expect(await countRects(page)).toEqual({
    detached: ELEMENT_COUNT,
    withRect: ELEMENT_COUNT,
  });
});

test('a large subtree removed at once is tracked in full', async ({page}) => {
  await addElements(page);
  await page.evaluate(() => {
    const w = window as AnyValue;
    w.kept = document.getElementById('container');
    w.kept.remove();
  });
  await wait(100);
  expect(await countRects(page)).toEqual({
    detached: ELEMENT_COUNT + 1,
    withRect: ELEMENT_COUNT + 1,
  });
});
