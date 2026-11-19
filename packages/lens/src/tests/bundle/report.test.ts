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
import {
  forceGC,
  readReactScripts,
  runBundleFilePath,
  wait,
} from '../utils/test-utils';

test('window.__memlens.getReport() summarizes GC-confirmed leaks as JSON', async ({
  page,
}) => {
  await page.setContent(`<html><body style="margin:0"><div id="root"></div>
    ${readReactScripts('prod')}
    <script>
      window.__instances = [];
      class Dialog extends React.Component {
        componentDidMount() {
          window.__instances.push(this);
          window.addEventListener('resize', () => this.forceUpdate());
        }
        render() {
          return React.createElement('div', {
            style: {position: 'absolute', top: 30, left: 40, width: 320, height: 180},
          }, 'dialog');
        }
      }
      function App() {
        const [open, setOpen] = React.useState(true);
        const [, setTick] = React.useState(0);
        window.close = () => setOpen(false);
        window.rerender = () => setTick(t => t + 1);
        return React.createElement('main', null, open ? React.createElement(Dialog) : null);
      }
      const root = ReactDOM.createRoot(document.getElementById('root'));
      ReactDOM.flushSync(() => root.render(React.createElement(App)));
    </script></body></html>`);
  await page.addScriptTag({
    content: fs.readFileSync(runBundleFilePath, 'utf8'),
  });
  await wait(1200);
  await page.evaluate(() => {
    const w = window as AnyValue;
    w.__keepNode = document.querySelector('main > div');
    w.ReactDOM.flushSync(() => w.close());
    w.ReactDOM.flushSync(() => w.rerender());
    w.ReactDOM.flushSync(() => w.rerender());
  });
  await wait(1200);
  await forceGC(page);
  const report = await page.evaluate(() =>
    JSON.parse(JSON.stringify((window as AnyValue).__memlens.getReport())),
  );

  expect(report.totals.detachedElementsSurvivingGC).toBe(1);
  expect(report.gcCount).toBeGreaterThanOrEqual(1);
  expect(report.detachedElements).toEqual([
    {
      id: expect.stringMatching(/^memory-id-\d+@$/),
      tagName: 'DIV',
      componentStack: ['Dialog', 'App'],
      detachedForMs: expect.any(Number),
      gcSurvivedCount: expect.any(Number),
      rect: {x: 40, y: 30, width: 320, height: 180},
    },
  ]);
  expect(report.leakedComponents).toEqual([{component: 'Dialog', count: 1}]);
  const id = report.detachedElements[0].id;
  expect(
    await page.evaluate(
      (expected: string) =>
        (window as AnyValue).__keepNode.detachedElementIdStr === expected,
      id,
    ),
  ).toBe(true);
});
