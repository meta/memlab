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
import {readLibBundle} from '../utils/test-utils';

test.describe('event listener tracking', () => {
  test.beforeEach(async ({page}) => {
    await page.setContent('<!DOCTYPE html><html><body></body></html>');
    await page.addScriptTag({content: readLibBundle()});
  });

  test('a null listener is accepted, as without MemLens', async ({page}) => {
    const result = await page.evaluate(() => {
      const scan = (window as AnyValue).MemLens.createReactMemoryScan({
        trackEventListenerLeaks: true,
      });
      const div = document.createElement('div');
      document.body.appendChild(div);
      let error = null;
      try {
        div.addEventListener('click', null as AnyValue);
        div.removeEventListener('click', null as AnyValue);
      } catch (e) {
        error = String(e);
      }
      div.remove();
      const leaks = scan.scan().eventListenerLeaks;
      scan.dispose();
      return {error, leaks};
    });
    expect(result.error).toBeNull();
    expect(result.leaks).toEqual([]);
  });
});
