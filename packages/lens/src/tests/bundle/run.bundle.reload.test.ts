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

const START_LOG = 'Tracking React and DOM memory';
const WIDGET_ID = 'memory-visualization-control-widget';

test.describe('run.bundle.js start guard', () => {
  test('starts again after the page reloads', async ({page}) => {
    const bundleCode = fs.readFileSync(runBundleFilePath, 'utf8');
    await page.route('http://memlens.test/**', route =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!DOCTYPE html><html><body><div>app</div>
          <script>${bundleCode.replace(/<\/script>/g, '<\\/script>')}</script>
          </body></html>`,
      }),
    );
    let starts = 0;
    page.on('console', message => {
      if (message.text().includes(START_LOG)) {
        ++starts;
      }
    });

    await page.goto('http://memlens.test/');
    await wait(200);
    expect(starts).toBe(1);

    await page.reload();
    await wait(200);
    expect(starts).toBe(2);
    expect(await page.locator(`#${WIDGET_ID}`).count()).toBe(1);
  });

  test('starts once when injected twice into the same page', async ({page}) => {
    const bundleCode = fs.readFileSync(runBundleFilePath, 'utf8');
    let starts = 0;
    page.on('console', message => {
      if (message.text().includes(START_LOG)) {
        ++starts;
      }
    });
    await page.setContent(
      '<!DOCTYPE html><html><body><div>app</div></body></html>',
    );
    await page.addScriptTag({content: bundleCode});
    await page.addScriptTag({content: bundleCode});
    await wait(200);

    expect(starts).toBe(1);
    expect(await page.locator(`#${WIDGET_ID}`).count()).toBe(1);
  });
});
