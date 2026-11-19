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
  runBundleFilePath,
  wait,
} from '../utils/test-utils';

test('only detached elements that survive a full GC are reported', async ({
  page,
}) => {
  await page.setContent('<!DOCTYPE html><html><body></body></html>');
  await page.addScriptTag({content: readLibBundle()});
  const before = await page.evaluate(() => {
    const w = window as AnyValue;
    w.__scan = w.MemLens.createReactMemoryScan();
    for (let i = 0; i < 200; i++) {
      document.body.appendChild(document.createElement('p'));
    }
    const kept = document.createElement('section');
    document.body.appendChild(kept);
    w.__scan.scan();
    document.querySelectorAll('p').forEach(p => p.remove());
    kept.remove();
    w.__kept = kept;
    const result = w.__scan.scan();
    return {
      detached: result.totalDetachedElements,
      survivingGC: result.totalDetachedElementsSurvivingGC,
      reported: w.__scan.getDetachedDOMInfo().length,
      pending: w.__scan.getDetachedDOMInfo({includeUnconfirmed: true}).length,
    };
  });
  await forceGC(page);
  const after = await page.evaluate(() => {
    const w = window as AnyValue;
    const result = w.__scan.scan();
    const reported = w.__scan.getDetachedDOMInfo();
    return {
      detached: result.totalDetachedElements,
      survivingGC: result.totalDetachedElementsSurvivingGC,
      reported: reported.map((info: AnyValue) => ({
        tag: info.element.deref()?.tagName,
        gcSurvivedCount: info.gcSurvivedCount,
      })),
    };
  });

  expect(before).toEqual({
    detached: 201,
    survivingGC: 0,
    reported: 0,
    pending: 201,
  });
  expect(after).toEqual({
    detached: 1,
    survivingGC: 1,
    reported: [{tag: 'SECTION', gcSurvivedCount: 1}],
  });
});

test('the overlay outlines a detached element faded until it survives a full GC', async ({
  page,
}) => {
  await page.setContent(`<!DOCTYPE html><html><body style="margin:0">
    <div id="kept" style="width:300px;height:200px"></div>
    <div id="garbage" style="width:300px;height:100px"></div></body></html>`);
  await page.addScriptTag({
    content: fs.readFileSync(runBundleFilePath, 'utf8'),
  });
  await wait(1200);
  await page.evaluate(() => {
    const kept = document.getElementById('kept');
    (window as AnyValue).__keep = kept;
    kept?.remove();
    document.getElementById('garbage')?.remove();
  });
  await wait(2200);
  const boxes = () =>
    page.evaluate(() => {
      const overlay = document.getElementById('memory-visualization-overlay');
      return Array.from(overlay?.children ?? []).map(box => {
        const style = (box as HTMLElement).style;
        return {height: style.height, border: style.borderStyle};
      });
    });
  // both are outlined right away, in the faded "waiting for GC" style
  expect(await boxes()).toEqual([
    {height: '200px', border: 'dashed'},
    {height: '100px', border: 'dashed'},
  ]);
  await page.evaluate(() => {
    (window as AnyValue).__keptBox = document.getElementById(
      'memory-visualization-overlay',
    )?.firstElementChild;
  });
  await forceGC(page);
  await wait(1200);
  // the collected one is gone and the kept one is now confirmed, in place
  expect(await boxes()).toEqual([{height: '200px', border: 'dotted'}]);
  expect(
    await page.evaluate(
      () =>
        document.getElementById('memory-visualization-overlay')
          ?.firstElementChild === (window as AnyValue).__keptBox,
    ),
  ).toBe(true);
});
