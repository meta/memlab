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

test('the widget summarizes leaked components and listeners, and copies the report', async ({
  page,
  context,
}) => {
  // the clipboard needs a secure origin
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'https://memlens.test',
  });
  const html = `<html><body style="margin:0"><div id="root"></div>
    ${readReactScripts('prod')}
    <script>${fs
      .readFileSync(runBundleFilePath, 'utf8')
      .replace(/<\/script>/g, '<\\/script>')}</script>
    <script>
      window.__instances = [];
      class Dialog extends React.Component {
        componentDidMount() {
          window.__instances.push(this);
          window.addEventListener('resize', () => this.forceUpdate());
        }
        render() {
          // keeps its DOM node, as a cached ref would
          return React.createElement('div', {
            ref: node => node && window.__instances.push(node),
            style: {width: 200, height: 120},
          }, 'dialog');
        }
      }
      function App() {
        const [open, setOpen] = React.useState(false);
        const [, setTick] = React.useState(0);
        window.setOpen = setOpen;
        window.rerender = () => setTick(t => t + 1);
        return React.createElement('main', null, open ? React.createElement(Dialog) : null);
      }
      const root = ReactDOM.createRoot(document.getElementById('root'));
      ReactDOM.flushSync(() => root.render(React.createElement(App)));
    </script></body></html>`;
  await page.route('https://memlens.test/**', route =>
    route.fulfill({contentType: 'text/html', body: html}),
  );
  await page.goto('https://memlens.test/');
  await wait(1200);
  // open and close the dialog three times, scanning in between
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      const w = window as AnyValue;
      w.ReactDOM.flushSync(() => w.setOpen(true));
    });
    await wait(1100);
    await page.evaluate(() => {
      const w = window as AnyValue;
      w.ReactDOM.flushSync(() => w.setOpen(false));
      w.ReactDOM.flushSync(() => w.rerender());
      w.ReactDOM.flushSync(() => w.rerender());
    });
    await wait(1100);
  }
  const status = () =>
    page
      .locator('#memory-visualization-control-widget > div:first-child')
      .innerText();
  const summary = () =>
    page.locator('#memory-visualization-leak-summary > div').innerText();

  expect(await status()).toMatch(/\(\+\d+ waiting for GC\)/);
  await forceGC(page);
  await wait(1200);

  expect(await status()).toMatch(/^DOM: \d+ total, 3 detached after GC/);
  expect(await summary()).toMatch(
    /^Outlines: 3 on screen · React: Dialog ×3 · Listeners: \d+ on detached elements, 1 growing site on window\/document · GCs: \d+$/,
  );

  await page.click('#memory-visualization-leak-summary button');
  await expect(
    page.locator('#memory-visualization-leak-summary button'),
  ).toHaveText('Copied');
  const report = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  );
  expect(report.totals.detachedElementsSurvivingGC).toBe(3);
  expect(report.leakedComponents).toEqual([{component: 'Dialog', count: 3}]);
  expect(report.globalListenerSites[0]).toMatchObject({
    target: 'window',
    type: 'resize',
    count: 3,
  });
});
