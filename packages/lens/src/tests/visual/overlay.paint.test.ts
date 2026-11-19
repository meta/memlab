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

function overlayBoxes(page: AnyValue): Promise<Array<AnyValue>> {
  return page.evaluate(() =>
    Array.from(
      document.getElementById('memory-visualization-overlay')?.children ?? [],
    ).map(box => {
      const style = (box as HTMLElement).style;
      return {
        width: style.width,
        height: style.height,
        zIndex: style.zIndex,
      };
    }),
  );
}

test('an element without a size does not stop the overlay from painting others', async ({
  page,
}) => {
  await page.setContent(
    '<!DOCTYPE html><html><body style="margin:0"><div>app</div></body></html>',
  );
  await page.addScriptTag({
    content: fs.readFileSync(runBundleFilePath, 'utf8'),
  });
  await wait(1200);
  // added and removed between two scans, so it never had a size on screen
  await page.evaluate(() => {
    const brief = document.createElement('section');
    document.body.appendChild(brief);
    brief.remove();
    (window as AnyValue).__keep = [brief];
  });
  await wait(1000);
  await page.evaluate(() => {
    const card = document.createElement('div');
    card.style.cssText = 'width:300px;height:200px;margin:40px';
    document.body.appendChild(card);
    (window as AnyValue).__keep.push(card);
  });
  await wait(1000);
  await page.evaluate(() => (window as AnyValue).__keep[1].remove());
  await wait(1500);

  expect(await overlayBoxes(page)).toEqual([
    {width: '300px', height: '200px', zIndex: expect.stringMatching(/^\d+$/)},
  ]);
  // the element without a size is not outlined but is still counted
  const status = await page
    .locator('#memory-visualization-control-widget > div:first-child')
    .innerText();
  expect(status).toMatch(/ 2 detached/);
});
