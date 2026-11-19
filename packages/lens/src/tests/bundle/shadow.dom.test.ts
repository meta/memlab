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
import {forceGC, readLibBundle, readReactScripts} from '../utils/test-utils';

test.describe('shadow DOM', () => {
  test.beforeEach(async ({page}) => {
    await page.setContent(`<html><body><div id="host"></div>
      ${readReactScripts('prod')}
      <script>${readLibBundle()}</script>
      <script>
        function Item({n}) { return React.createElement('li', null, 'item ' + n); }
        function ShadowList() {
          return React.createElement('ul', null,
            [0, 1, 2].map(i => React.createElement(Item, {key: i, n: i})));
        }
        const shadow = document.getElementById('host').attachShadow({mode: 'open'});
        const mount = document.createElement('div');
        shadow.appendChild(mount);
        const root = ReactDOM.createRoot(mount);
        ReactDOM.flushSync(() => root.render(React.createElement(ShadowList)));
      </script></body></html>`);
  });

  test('a React root inside an open shadow root is walked', async ({page}) => {
    const counts = await page.evaluate(() => {
      const w = window as AnyValue;
      const scan = w.MemLens.createReactMemoryScan({scanIntervalMs: 60000});
      scan.start();
      const result = Object.fromEntries(scan.scan().componentToFiberNodeCount);
      scan.stop();
      return result;
    });
    expect(counts).toEqual({ShadowList: 1, Item: 3});
  });

  test('removals inside open and closed shadow roots are reported', async ({
    page,
  }) => {
    await page.evaluate(async () => {
      const w = window as AnyValue;
      w.__scan = w.MemLens.createReactMemoryScan({scanIntervalMs: 60000});
      w.__scan.start();
      const removeWithRange = (node: Node) => {
        const range = document.createRange();
        range.selectNode(node);
        range.deleteContents();
      };
      // open shadow root that existed before start()
      const openRoot = document.getElementById('host')?.shadowRoot;
      const note = document.createElement('aside');
      openRoot?.appendChild(note);
      // closed shadow root attached after start()
      const closedHost = document.createElement('section');
      document.body.appendChild(closedHost);
      const closedRoot = closedHost.attachShadow({mode: 'closed'});
      const badge = document.createElement('mark');
      closedRoot.appendChild(badge);
      w.__keep = [note, badge];
      removeWithRange(note);
      removeWithRange(badge);
      await new Promise(resolve => setTimeout(resolve, 0));
      w.__scan.scan();
    });
    await forceGC(page);
    const reported = await page.evaluate(() =>
      (window as AnyValue).__scan
        .getDetachedDOMInfo()
        .map((info: AnyValue) => info.element.deref()?.tagName)
        .sort(),
    );
    expect(reported).toEqual(['ASIDE', 'MARK']);
  });

  test('attachShadow is restored when the scanner stops', async ({page}) => {
    const native = await page.evaluate(() => {
      const isNative = () =>
        String(Element.prototype.attachShadow).includes('[native code]');
      const scan = (window as AnyValue).MemLens.createReactMemoryScan();
      scan.start();
      const running = isNative();
      scan.stop();
      return {running, stopped: isNative()};
    });
    expect(native).toEqual({running: false, stopped: true});
  });
});
