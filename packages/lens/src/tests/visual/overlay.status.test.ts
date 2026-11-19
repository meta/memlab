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

const statusText = (page: import('@playwright/test').Page) =>
  page
    .locator('#memory-visualization-control-widget > div:first-child')
    .innerText();

test('the status shows the heap as an approximation', async ({page}) => {
  await page.setContent(
    '<!DOCTYPE html><html><body><div>app</div></body></html>',
  );
  await page.addScriptTag({
    content: fs.readFileSync(runBundleFilePath, 'utf8'),
  });
  await wait(1200);
  expect(await statusText(page)).toMatch(
    /^DOM: \d+ total, \d+ detached after GC \| Heap ≈ /,
  );
});

test('the status leaves out the heap where the browser does not report it', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Performance.prototype, 'memory', {
      get: () => undefined,
    });
  });
  await page.goto('about:blank');
  await page.setContent(
    '<!DOCTYPE html><html><body><div>app</div></body></html>',
  );
  await page.addScriptTag({
    content: fs.readFileSync(runBundleFilePath, 'utf8'),
  });
  await wait(1200);
  expect(await statusText(page)).toMatch(
    /^DOM: \d+ total, \d+ detached after GC$/,
  );
});
