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
import type {ReactBuild} from '../utils/test-utils';

const APP = `
  function Item({n}) { return React.createElement('li', null, 'item ' + n); }
  function Extra() { return React.createElement('p', null, 'extra'); }
  function App() {
    const [n, setN] = React.useState(0);
    const [extra, setExtra] = React.useState(true);
    window.bump = () => setN(v => v + 1);
    window.hideExtra = () => setExtra(false);
    return React.createElement('div', null,
      React.createElement('ul', null,
        [0, 1, 2, 3, 4].map(i => React.createElement(Item, {key: i, n: n + i}))),
      extra ? React.createElement(Extra) : null);
  }
  const root = ReactDOM.createRoot(document.getElementById('root'));
  ReactDOM.flushSync(() => root.render(React.createElement(App)));
`;

for (const build of ['dev', 'prod'] as ReactBuild[]) {
  for (const rerenders of [0, 1]) {
    test(`scan walks the current fiber tree after ${rerenders} re-render(s) and an unmount (React 18 ${build})`, async ({
      page,
    }) => {
      await page.setContent(`<html><body><div id="root"></div>
        ${readReactScripts(build)}
        <script>${readLibBundle()}</script>
        <script>${APP}</script></body></html>`);

      const names = await page.evaluate(count => {
        const w = window as AnyValue;
        for (let i = 0; i < count; i++) {
          w.ReactDOM.flushSync(() => w.bump());
        }
        w.ReactDOM.flushSync(() => w.hideExtra());
        const scan = w.MemLens.createReactMemoryScan();
        return scan.scan().fiberNodes.map((ref: WeakRef<AnyValue>) => {
          const fiber = ref.deref();
          if (typeof fiber?.type === 'string') {
            return fiber.type;
          }
          return fiber?.type?.name ?? `tag:${fiber?.tag}`;
        });
      }, rerenders);

      expect(names.filter((name: string) => name === 'Item')).toHaveLength(5);
      expect(names.filter((name: string) => name === 'li')).toHaveLength(5);
      expect(names).toContain('App');
      expect(names).not.toContain('Extra');
    });
  }
}
