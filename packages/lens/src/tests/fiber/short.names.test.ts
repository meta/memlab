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
import {readLibBundle, readReactScripts} from '../utils/test-utils';

test('scan keeps three-letter component names and drops minified ones', async ({
  page,
}) => {
  await page.setContent(`<html><body><div id="root"></div>
    ${readReactScripts('prod')}
    <script>${readLibBundle()}</script>
    <script>
      function Row() { return React.createElement('li', null, 'row'); }
      function Nav() { return React.createElement('ul', null, React.createElement(Row), React.createElement(Row)); }
      const Zt = () => React.createElement('span', null, 'minified');
      const xQ1 = () => React.createElement('span', null, 'minified');
      function App() {
        return React.createElement('div', null, React.createElement(Nav), React.createElement(Zt), React.createElement(xQ1));
      }
      const root = ReactDOM.createRoot(document.getElementById('root'));
      ReactDOM.flushSync(() => root.render(React.createElement(App)));
    </script></body></html>`);

  const counts = await page.evaluate(() => {
    const scan = (window as AnyValue).MemLens.createReactMemoryScan();
    return Object.fromEntries(scan.scan().componentToFiberNodeCount);
  });

  expect(counts.App).toBe(1);
  expect(counts.Nav).toBe(1);
  expect(counts.Row).toBe(2);
  expect(counts.Zt).toBeUndefined();
  expect(counts.xQ1).toBeUndefined();
});
