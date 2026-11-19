/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import {test, expect} from '@playwright/test';
import fs from 'fs';
import {runBundleFilePath, wait} from '../utils/test-utils';

test('the toggle keeps its size and its knob when the status text is long', async ({
  page,
}) => {
  // a five-digit element count and thousands of elements waiting for a GC
  // make the status line longer than the widget is wide
  await page.setContent(
    '<!DOCTYPE html><html><body><div id="app"></div></body></html>',
  );
  await page.evaluate(() => {
    const app = document.getElementById('app') as HTMLElement;
    for (let i = 0; i < 20000; ++i) {
      app.appendChild(document.createElement('span'));
    }
  });
  await page.addScriptTag({
    content: fs.readFileSync(runBundleFilePath, 'utf8'),
  });
  await wait(1200);
  await page.evaluate(() => {
    const app = document.getElementById('app') as HTMLElement;
    (window as unknown as {kept: Element[]}).kept = Array.from(
      app.children,
    ).slice(0, 5000);
    for (const child of (window as unknown as {kept: Element[]}).kept) {
      child.remove();
    }
  });
  await wait(1200);

  const header = '#memory-visualization-control-widget > div:first-child';
  const toggle = page.locator(`${header} > div:first-child`);
  const knob = toggle.locator('div');
  expect(await page.locator(header).innerText()).toContain('waiting for GC');

  const inside = async () => {
    const track = await toggle.boundingBox();
    const circle = await knob.boundingBox();
    if (track == null || circle == null) {
      return null;
    }
    return {
      trackWidth: track.width,
      fits:
        circle.x >= track.x && circle.x + circle.width <= track.x + track.width,
    };
  };
  expect(await inside()).toEqual({trackWidth: 40, fits: true});
  await toggle.click();
  await wait(400);
  expect(await inside()).toEqual({trackWidth: 40, fits: true});
});
