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
import fs from 'fs';
import {runBundleFilePath, wait} from '../utils/test-utils';

const boxCount = (page: AnyValue): Promise<number> =>
  page.evaluate(
    () =>
      document.getElementById('memory-visualization-overlay')?.children
        .length ?? 0,
  );

test('the D shortcut hides the selected box, but not while typing', async ({
  page,
}) => {
  await page.setContent(`<!DOCTYPE html><html><body style="margin:0">
    <div id="card" style="position:absolute;top:40px;left:40px;width:300px;height:200px"></div>
    <input id="search" style="position:absolute;top:400px;left:40px">
  </body></html>`);
  await page.addScriptTag({
    content: fs.readFileSync(runBundleFilePath, 'utf8'),
  });
  await wait(1200);
  await page.evaluate(() => {
    const card = document.getElementById('card');
    (window as AnyValue).__keep = card;
    card?.remove();
  });
  await wait(1200);
  expect(await boxCount(page)).toBe(1);

  // select the box by hovering it, then type "d" into the input
  await page.mouse.move(190, 140);
  await page.focus('#search');
  await page.keyboard.type('add');
  await wait(1200);
  expect(await page.inputValue('#search')).toBe('add');
  expect(await boxCount(page)).toBe(1);

  // the same key outside an input hides the box
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.mouse.move(190, 140);
  await page.keyboard.press('d');
  await wait(1200);
  expect(await boxCount(page)).toBe(0);
});
