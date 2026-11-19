/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import type {Page} from '@playwright/test';
import fs from 'fs';
import path from 'path';

// export a function that returns the absolute path to the dist folder

export const distPath = path.join(__dirname, '..', '..', '..', 'dist');
export const srcPath = path.join(__dirname, '..', '..', '..', 'src');

export async function wait(timeoutInMs: number) {
  await new Promise(resolve => setTimeout(resolve, timeoutInMs));
}

export const libBundleFile = 'memlens.lib.bundle.js';
export const libBundleFilePath = path.join(distPath, libBundleFile);
export const libBundleMinFile = 'memlens.lib.bundle.min.js';
export const libBundleMinFilePath = path.join(distPath, libBundleMinFile);
export const runBundleFile = 'memlens.run.bundle.js';
export const runBundleFilePath = path.join(distPath, runBundleFile);
export const runBundleMinFile = 'memlens.run.bundle.min.js';
export const runBundleMinFilePath = path.join(distPath, runBundleMinFile);

export type ReactBuild = 'dev' | 'prod';

export function readReactScripts(build: ReactBuild): string {
  const react = fs.readFileSync(
    path.join(srcPath, 'tests', 'lib', `react-v18.${build}.js`),
    'utf8',
  );
  const reactDOM = fs.readFileSync(
    path.join(srcPath, 'tests', 'lib', `react-dom-v18.${build}.js`),
    'utf8',
  );
  return `<script>${react}</script><script>${reactDOM}</script>`;
}

export function readLibBundle(): string {
  return fs.readFileSync(libBundleFilePath, 'utf8');
}

/**
 * Runs `count` full GCs through CDP, letting FinalizationRegistry callbacks
 * run in between. MemLens counts a full GC only after its sentinel has
 * survived two GCs, so three forced GCs advance its count by about one.
 */
export async function forceGC(page: Page, count = 3): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  for (let i = 0; i < count; i++) {
    await cdp.send('HeapProfiler.collectGarbage');
    await wait(30);
  }
  await cdp.detach();
}
