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
import {
  forceGC,
  readLibBundle,
  readReactScripts,
  wait,
} from '../utils/test-utils';

const APP = `
  function Item({n}) { return React.createElement('li', null, 'item ' + n); }
  function List({count}) {
    return React.createElement('ul', null,
      Array.from({length: count}, (_, i) => React.createElement(Item, {key: i, n: i})));
  }
  const root = ReactDOM.createRoot(document.getElementById('root'));
  ReactDOM.flushSync(() => root.render(React.createElement(List, {count: 20})));
`;

test.describe('scanning while started (no DOM sweep)', () => {
  test.beforeEach(async ({page}) => {
    await page.setContent(`<html><body><div id="root"></div><div id="later"></div>
      ${readReactScripts('prod')}
      <script>${readLibBundle()}</script>
      <script>${APP}</script></body></html>`);
  });

  test('component counts match a full sweep', async ({page}) => {
    const counts = await page.evaluate(() => {
      const {MemLens} = window as AnyValue;
      const swept = MemLens.createReactMemoryScan().scan();
      const started = MemLens.createReactMemoryScan({scanIntervalMs: 60000});
      started.start();
      const result = started.scan();
      started.stop();
      return {
        swept: Object.fromEntries(swept.componentToFiberNodeCount),
        started: Object.fromEntries(result.componentToFiberNodeCount),
        fibers: [swept.fiberNodes.length, result.fiberNodes.length],
      };
    });
    expect(counts.started).toEqual({List: 1, Item: 20});
    expect(counts.started).toEqual(counts.swept);
    expect(counts.fibers[1]).toBe(counts.fibers[0]);
  });

  test('a React root created after start() is walked', async ({page}) => {
    const items = await page.evaluate(async () => {
      const w = window as AnyValue;
      const scan = w.MemLens.createReactMemoryScan({scanIntervalMs: 60000});
      scan.start();
      const second = w.ReactDOM.createRoot(document.getElementById('later'));
      w.ReactDOM.flushSync(() =>
        second.render(w.React.createElement(w.List, {count: 5})),
      );
      // let the MutationObserver report the root's first render
      await new Promise(resolve => setTimeout(resolve, 0));
      const result = scan.scan();
      scan.stop();
      return result.componentToFiberNodeCount.get('Item');
    });
    expect(items).toBe(25);
  });

  test('an element removed by a Range is still reported', async ({page}) => {
    await page.evaluate(async () => {
      const w = window as AnyValue;
      w.__scan = w.MemLens.createReactMemoryScan({scanIntervalMs: 60000});
      w.__scan.start();
      const banner = document.createElement('aside');
      document.body.appendChild(banner);
      w.__keep = banner;
      const range = document.createRange();
      range.selectNode(banner);
      range.deleteContents();
      await new Promise(resolve => setTimeout(resolve, 0));
      w.__scan.scan();
    });
    await forceGC(page);
    const reported = await page.evaluate(() =>
      (window as AnyValue).__scan
        .getDetachedDOMInfo()
        .map((info: AnyValue) => info.element.deref()?.tagName),
    );
    expect(reported).toEqual(['ASIDE']);
  });

  test('an element removed past the rect budget keeps the rect it had when added', async ({
    page,
  }) => {
    await page.evaluate(() => {
      const w = window as AnyValue;
      w.__scan = w.MemLens.createReactMemoryScan({scanIntervalMs: 60000});
      w.__scan.start();
      const grid = document.createElement('section');
      for (let i = 0; i < 3000; i++) {
        const cell = document.createElement('div');
        cell.style.cssText = 'display:inline-block;width:12px;height:8px';
        grid.appendChild(cell);
      }
      document.body.appendChild(grid);
      w.__grid = grid;
    });
    // the rects of added elements are recorded in the next frame
    await wait(200);
    await page.evaluate(() => {
      const w = window as AnyValue;
      const cells = Array.from(w.__grid.children) as HTMLElement[];
      // every removal changes the layout, so each rect read forces a layout
      for (const cell of cells) {
        cell.remove();
        w.__grid.style.paddingTop = `${cells.indexOf(cell) % 7}px`;
      }
      w.__keep = cells[cells.length - 1];
      w.__scan.scan();
    });
    await forceGC(page);
    const rect = await page.evaluate(() => {
      const w = window as AnyValue;
      w.__scan.scan();
      const info = w.__scan
        .getDetachedDOMInfo()
        .find((entry: AnyValue) => entry.element.deref() === w.__keep);
      return (
        info?.boundingRect && {
          width: info.boundingRect.width,
          height: info.boundingRect.height,
        }
      );
    });
    expect(rect).toEqual({width: 12, height: 8});
  });
});
