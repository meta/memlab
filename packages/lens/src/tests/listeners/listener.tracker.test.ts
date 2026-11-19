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

async function leaksAfter(
  page: AnyValue,
  register: string,
): Promise<Array<{type: string; count: number}>> {
  return await page.evaluate((body: string) => {
    const scan = (window as AnyValue).MemLens.createReactMemoryScan({
      trackEventListenerLeaks: true,
    });
    const div = document.createElement('div');
    document.body.appendChild(div);
    new Function('div', body)(div);
    div.remove();
    (window as AnyValue).__keep = div;
    const leaks = scan.scan().eventListenerLeaks;
    scan.dispose();
    return leaks.map(({type, count}: AnyValue) => ({type, count}));
  }, register);
}

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
  test('removal with a new options object matches like the DOM', async ({
    page,
  }) => {
    const leaks = await leaksAfter(
      page,
      `const f = () => {};
       div.addEventListener('click', f, {capture: false, passive: true});
       div.removeEventListener('click', f, {capture: false});`,
    );
    expect(leaks).toEqual([]);
  });

  test('removal without options matches a listener added with false', async ({
    page,
  }) => {
    const leaks = await leaksAfter(
      page,
      `const f = () => {};
       div.addEventListener('click', f, false);
       div.removeEventListener('click', f);`,
    );
    expect(leaks).toEqual([]);
  });

  test('a duplicate add is ignored like the DOM ignores it', async ({page}) => {
    const leaks = await leaksAfter(
      page,
      `const f = () => {};
       div.addEventListener('click', f);
       div.addEventListener('click', f);
       div.removeEventListener('click', f);`,
    );
    expect(leaks).toEqual([]);
  });

  test('a removal with a different capture flag keeps the listener', async ({
    page,
  }) => {
    const leaks = await leaksAfter(
      page,
      `const f = () => {};
       div.addEventListener('click', f, true);
       div.removeEventListener('click', f, false);`,
    );
    expect(leaks).toEqual([{type: 'click', count: 1}]);
  });
  test('a once listener is forgotten after it runs', async ({page}) => {
    const leaks = await leaksAfter(
      page,
      `div.addEventListener('click', () => {}, {once: true});
       div.click();`,
    );
    expect(leaks).toEqual([]);
  });

  test('a once listener that never ran is still reported', async ({page}) => {
    const leaks = await leaksAfter(
      page,
      `div.addEventListener('click', () => {}, {once: true});`,
    );
    expect(leaks).toEqual([{type: 'click', count: 1}]);
  });

  test('a listener is forgotten when its signal aborts', async ({page}) => {
    const leaks = await leaksAfter(
      page,
      `const controller = new AbortController();
       div.addEventListener('click', () => {}, {signal: controller.signal});
       controller.abort();`,
    );
    expect(leaks).toEqual([]);
  });

  test('a listener with an already aborted signal is not recorded', async ({
    page,
  }) => {
    const leaks = await leaksAfter(
      page,
      `div.addEventListener('click', () => {}, {signal: AbortSignal.abort()});`,
    );
    expect(leaks).toEqual([]);
  });
});
