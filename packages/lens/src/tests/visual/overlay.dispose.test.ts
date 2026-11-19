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

test('dispose removes the overlay, its document listeners and its boxes', async ({
  page,
  context,
}) => {
  await page.setContent(`<!DOCTYPE html><html><body style="margin:0">
    <div id="card" style="width:300px;height:200px"></div></body></html>`);
  const cdp = await context.newCDPSession(page);
  const documentListenerTypes = async (): Promise<string[]> => {
    const {result} = await cdp.send('Runtime.evaluate', {
      expression: 'document',
    });
    const {listeners} = await cdp.send('DOMDebugger.getEventListeners', {
      objectId: result.objectId as string,
    });
    return listeners.map(listener => listener.type).sort();
  };
  const before = await documentListenerTypes();

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
  const whileRunning = await documentListenerTypes();
  await page.evaluate(() => {
    const box = document.getElementById(
      'memory-visualization-overlay',
    )?.firstElementChild;
    (window as AnyValue).__boxRef = box ? new WeakRef(box) : null;
    (window as AnyValue).__memlens.dispose();
  });
  await cdp.send('HeapProfiler.collectGarbage');
  const after = await page.evaluate(() => ({
    overlay: document.getElementById('memory-visualization-overlay') != null,
    widget:
      document.getElementById('memory-visualization-control-widget') != null,
    hadBox: (window as AnyValue).__boxRef != null,
    boxAlive: (window as AnyValue).__boxRef?.deref() != null,
  }));

  expect(whileRunning).toEqual(
    expect.arrayContaining(['keydown', 'mousemove', 'mouseup']),
  );
  expect(await documentListenerTypes()).toEqual(before);
  expect(after).toEqual({
    overlay: false,
    widget: false,
    hadBox: true,
    boxAlive: false,
  });
});
