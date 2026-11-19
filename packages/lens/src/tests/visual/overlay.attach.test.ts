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

test('the overlay stays attached instead of being re-appended on every scan', async ({
  page,
}) => {
  await page.setContent(
    '<!DOCTYPE html><html><body><div>app</div></body></html>',
  );
  await page.addScriptTag({
    content: fs.readFileSync(runBundleFilePath, 'utf8'),
  });
  await wait(1200);
  const mutations = await page.evaluate(async () => {
    let count = 0;
    const observer = new MutationObserver(records => {
      for (const record of records) {
        count += record.addedNodes.length + record.removedNodes.length;
      }
    });
    observer.observe(document.body, {childList: true});
    await new Promise(resolve => setTimeout(resolve, 3200));
    observer.disconnect();
    return count;
  });
  expect(mutations).toBe(0);
});

test('the widget appears when MemLens starts before <body> exists', async ({
  page,
}) => {
  const bundle = fs.readFileSync(runBundleFilePath, 'utf8');
  await page.setContent(
    `<!DOCTYPE html><html><head><script>${bundle.replace(
      /<\/script>/g,
      '<\\/script>',
    )}</script></head><body><div>app</div></body></html>`,
  );
  await wait(1500);
  const attached = await page.evaluate(() => ({
    widget:
      document.getElementById('memory-visualization-control-widget') != null,
    overlay: document.getElementById('memory-visualization-overlay') != null,
    scanner: (window as AnyValue).__memlens != null,
  }));
  expect(attached).toEqual({widget: true, overlay: true, scanner: true});
});
