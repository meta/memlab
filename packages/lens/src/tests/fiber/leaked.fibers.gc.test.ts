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
import type {ReactBuild} from '../utils/test-utils';

const APP = `
  // keeps every instance it mounts, so their fibers can never be collected
  window.__instances = [];
  class Leaky extends React.Component {
    componentDidMount() { window.__instances.push(this); }
    render() { return React.createElement('p', null, 'leaky'); }
  }
  function Clean() { return React.createElement('p', null, 'clean'); }
  function App() {
    const [shown, setShown] = React.useState(true);
    const [, setTick] = React.useState(0);
    window.hideAll = () => setShown(false);
    window.rerender = () => setTick(tick => tick + 1);
    return React.createElement('div', null,
      shown ? React.createElement(Leaky) : null,
      shown ? React.createElement(Clean) : null);
  }
  const root = ReactDOM.createRoot(document.getElementById('root'));
  ReactDOM.flushSync(() => root.render(React.createElement(App)));
`;

const leakedNames = (page: AnyValue): Promise<string[]> =>
  page.evaluate(() =>
    (window as AnyValue).__scan
      .scan()
      .leakedFibers.map((ref: WeakRef<AnyValue>) => ref.deref()?.type?.name)
      .filter(Boolean),
  );

for (const build of ['dev', 'prod'] as ReactBuild[]) {
  test(`only unmounted fibers that survive a full GC are reported (React 18 ${build})`, async ({
    page,
  }) => {
    await page.setContent(`<html><body><div id="root"></div>
      ${readReactScripts(build)}
      <script>${readLibBundle()}</script>
      <script>${APP}</script></body></html>`);
    await page.evaluate(() => {
      const w = window as AnyValue;
      w.__scan = w.MemLens.createReactMemoryScan();
      w.__scan.scan();
      w.ReactDOM.flushSync(() => w.hideAll());
      // React keeps deleted fibers in the parent's alternate (`deletions`)
      // until the parent renders again; two renders reuse both copies
      w.ReactDOM.flushSync(() => w.rerender());
      w.ReactDOM.flushSync(() => w.rerender());
    });

    expect(await leakedNames(page)).toEqual([]);
    await forceGC(page);
    expect(await leakedNames(page)).toEqual(['Leaky']);
  });
}
