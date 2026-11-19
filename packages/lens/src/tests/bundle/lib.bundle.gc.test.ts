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
import {forceGC, readLibBundle} from '../utils/test-utils';

test('the scanner counts full garbage collections', async ({page}) => {
  await page.setContent('<!DOCTYPE html><html><body></body></html>');
  await page.addScriptTag({content: readLibBundle()});
  await page.evaluate(() => {
    (window as AnyValue).__scan = (
      window as AnyValue
    ).MemLens.createReactMemoryScan();
  });
  const gcCount = () =>
    page.evaluate(() => (window as AnyValue).__scan.scan().gcCount);

  const start = await gcCount();
  await forceGC(page, 9);
  const afterNine = await gcCount();

  expect(start).toBe(0);
  expect(afterNine).toBeGreaterThanOrEqual(2);
  expect(afterNine).toBeLessThanOrEqual(9);
});
