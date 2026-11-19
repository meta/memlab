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
  test(`leaked fibers: re-renders report nothing, an unmount reports the component (React 18 ${build})`, async ({
    page,
  }) => {
    await page.setContent(`<html><body><div id="root"></div>
      ${readReactScripts(build)}
      <script>${readLibBundle()}</script>
      <script>${APP}</script></body></html>`);

    const result = await page.evaluate(() => {
      const w = window as AnyValue;
      const nameOf = (ref: WeakRef<AnyValue>) => {
        const fiber = ref.deref();
        return fiber?.type?.name ?? `tag:${fiber?.tag}`;
      };
      const scan = w.MemLens.createReactMemoryScan();
      const leakedPerScan: string[][] = [];
      for (let i = 0; i < 4; i++) {
        leakedPerScan.push(scan.scan().leakedFibers.map(nameOf));
        w.ReactDOM.flushSync(() => w.bump());
      }
      leakedPerScan.push(scan.scan().leakedFibers.map(nameOf));
      w.ReactDOM.flushSync(() => w.hideExtra());
      const afterUnmount = scan.scan().leakedFibers.map(nameOf);
      return {leakedPerScan, afterUnmount};
    });

    for (const leaked of result.leakedPerScan) {
      expect(leaked).toEqual([]);
    }
    expect(result.afterUnmount).toContain('Extra');
    expect(result.afterUnmount).not.toContain('Item');
    expect(result.afterUnmount).not.toContain('tag:3');
  });
}
