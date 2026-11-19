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

test('the widget says where the outlines are', async ({page}) => {
  await page.setViewportSize({width: 1000, height: 600});
  await page.setContent(`<!DOCTYPE html><html><body style="margin:0;height:4000px">
    <div id="top" style="position:absolute;top:100px;width:200px;height:100px"></div>
    <div id="below" style="position:absolute;top:2500px;width:200px;height:100px"></div>
    <div id="hidden" style="display:none"><p>never laid out</p></div>
    </body></html>`);
  await page.addScriptTag({
    content: fs.readFileSync(runBundleFilePath, 'utf8'),
  });
  await wait(1200);
  const summary = () =>
    page.locator('#memory-visualization-leak-summary > div').innerText();
  expect(await summary()).not.toContain('Outlines');

  await page.evaluate(() => {
    const w = window as AnyValue;
    w.kept = ['top', 'below', 'hidden'].map(id => document.getElementById(id));
    for (const element of w.kept) {
      element.remove();
    }
  });
  await wait(1200);
  // the hidden div and its paragraph never had a size
  expect(await summary()).toMatch(
    /^Outlines: 1 on screen, 1 off-screen, 2 without a position /,
  );

  await page.evaluate(() => window.scrollTo(0, 2300));
  await wait(1200);
  expect(await summary()).toMatch(
    /^Outlines: 1 on screen, 1 off-screen, 2 without a position /,
  );
  await page.evaluate(() => window.scrollTo(0, 1000));
  await wait(1200);
  expect(await summary()).toMatch(
    /^Outlines: 0 on screen, 2 off-screen, 2 without a position /,
  );
});
