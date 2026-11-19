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
import {libBundleFilePath, wait} from '../utils/test-utils';

test.describe('ReactMemoryScan lifecycle', () => {
  test.beforeEach(async ({page}) => {
    await page.setContent(
      '<!DOCTYPE html><html><body><div>app</div></body></html>',
    );
    await page.addScriptTag({
      content: fs.readFileSync(libBundleFilePath, 'utf8'),
    });
  });

  test('calling start() twice runs one scan loop', async ({page}) => {
    await page.evaluate(() => {
      const w = window as AnyValue;
      w.__ticks = 0;
      const scan = w.MemLens.createReactMemoryScan({scanIntervalMs: 100});
      scan.subscribe(() => ++w.__ticks);
      scan.start();
      scan.start();
      w.__scan = scan;
    });
    await wait(1050);
    const ticks = await page.evaluate(() => (window as AnyValue).__ticks);
    expect(ticks).toBeGreaterThanOrEqual(8);
    expect(ticks).toBeLessThanOrEqual(11);
  });

  test('stop() clears the loop after start() was called twice', async ({
    page,
  }) => {
    await page.evaluate(() => {
      const w = window as AnyValue;
      w.__ticks = 0;
      const scan = w.MemLens.createReactMemoryScan({scanIntervalMs: 100});
      scan.subscribe(() => ++w.__ticks);
      scan.start();
      scan.start();
      scan.stop();
      scan.start();
    });
    await wait(1050);
    const ticks = await page.evaluate(() => (window as AnyValue).__ticks);
    expect(ticks).toBeGreaterThanOrEqual(8);
    expect(ticks).toBeLessThanOrEqual(11);
  });

  test('start() after pause() resumes the existing loop', async ({page}) => {
    await page.evaluate(() => {
      const w = window as AnyValue;
      w.__ticks = 0;
      const scan = w.MemLens.createReactMemoryScan({scanIntervalMs: 100});
      scan.subscribe(() => ++w.__ticks);
      scan.start();
      scan.pause();
      scan.start();
    });
    await wait(1050);
    const ticks = await page.evaluate(() => (window as AnyValue).__ticks);
    expect(ticks).toBeGreaterThanOrEqual(8);
    expect(ticks).toBeLessThanOrEqual(11);
  });
});
