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
  readLibBundle,
  readReactScripts,
  runBundleFilePath,
  wait,
} from '../utils/test-utils';

const overlayBoxes = (page: AnyValue): Promise<Array<AnyValue>> =>
  page.evaluate(() =>
    Array.from(
      document.getElementById('memory-visualization-overlay')?.children ?? [],
    ).map(box => {
      const {width, height, top, left} = (box as HTMLElement).style;
      return {width, height, top, left};
    }),
  );

test('an element removed between two scans is outlined where it was', async ({
  page,
}) => {
  await page.setContent(
    '<!DOCTYPE html><html><body style="margin:0"><div>app</div></body></html>',
  );
  await page.addScriptTag({
    content: fs.readFileSync(runBundleFilePath, 'utf8'),
  });
  await wait(1200);
  await page.evaluate(() => {
    const toast = document.createElement('div');
    toast.style.cssText =
      'position:absolute;top:120px;left:80px;width:300px;height:200px';
    document.body.appendChild(toast);
    (window as AnyValue).__keep = toast;
    setTimeout(() => toast.remove(), 50);
  });
  await wait(1200);
  await forceGC(page);
  await wait(1200);
  expect(await overlayBoxes(page)).toEqual([
    {width: '300px', height: '200px', top: '120px', left: '80px'},
  ]);
});

test('an element that moved before its removal is outlined at its last position', async ({
  page,
}) => {
  await page.setContent(`<!DOCTYPE html><html><body style="margin:0">
    <div id="panel" style="position:absolute;top:10px;left:10px;width:200px;height:100px"></div>
  </body></html>`);
  await page.addScriptTag({
    content: fs.readFileSync(runBundleFilePath, 'utf8'),
  });
  await wait(1200);
  await page.evaluate(() => {
    const panel = document.getElementById('panel') as HTMLElement;
    panel.style.top = '300px';
    panel.style.left = '250px';
    (window as AnyValue).__keep = panel;
    panel.remove();
  });
  await wait(1200);
  await forceGC(page);
  await wait(1200);
  expect(await overlayBoxes(page)).toEqual([
    {width: '200px', height: '100px', top: '300px', left: '250px'},
  ]);
});

test('a component unmounted between two scans keeps its component stack', async ({
  page,
}) => {
  await page.setContent(`<html><body><div id="root"></div>
    ${readReactScripts('prod')}
    <script>${readLibBundle()}</script>
    <script>
      function Popup() {
        return React.createElement('div', {ref: node => { if (node) window.__popupNode = node; }}, 'popup');
      }
      function App() {
        const [open, setOpen] = React.useState(false);
        window.setOpen = setOpen;
        return React.createElement('main', null, open ? React.createElement(Popup) : null);
      }
      const root = ReactDOM.createRoot(document.getElementById('root'));
      ReactDOM.flushSync(() => root.render(React.createElement(App)));
    </script></body></html>`);
  await page.evaluate(() => {
    const w = window as AnyValue;
    w.__scan = w.MemLens.createReactMemoryScan({scanIntervalMs: 60000});
    w.__scan.start();
    w.__scan.scan();
    // opened and closed with no scan in between
    w.ReactDOM.flushSync(() => w.setOpen(true));
    w.ReactDOM.flushSync(() => w.setOpen(false));
    w.__scan.scan();
  });
  await forceGC(page);
  const stacks = await page.evaluate(() => {
    const w = window as AnyValue;
    w.__scan.scan();
    return w.__scan
      .getDetachedDOMInfo()
      .map((info: AnyValue) => info.componentStack.slice(0, 2));
  });
  expect(stacks).toEqual([['Popup', 'App']]);
});

test('DOM removal methods are wrapped only while the scanner runs', async ({
  page,
}) => {
  await page.setContent('<!DOCTYPE html><html><body></body></html>');
  await page.addScriptTag({content: readLibBundle()});
  const state = await page.evaluate(() => {
    const isNative = () =>
      String(Node.prototype.removeChild).includes('[native code]') &&
      String(Element.prototype.remove).includes('[native code]') &&
      String(
        Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')?.set,
      ).includes('[native code]');
    const {MemLens} = window as AnyValue;
    const scan = MemLens.createReactMemoryScan();
    const beforeStart = isNative();
    scan.start();
    const running = isNative();
    scan.stop();
    const stopped = isNative();
    const optedOut = MemLens.createReactMemoryScan({captureOnRemoval: false});
    optedOut.start();
    const optedOutRunning = isNative();
    optedOut.stop();
    return {beforeStart, running, stopped, optedOutRunning};
  });
  expect(state).toEqual({
    beforeStart: true,
    running: false,
    stopped: true,
    optedOutRunning: true,
  });
});
