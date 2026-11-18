/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * Unit tests for `isDetachedElementName` (dom-names.ts): which detached nodes
 * are DOM nodes and which are the Blink records attached to them.
 *
 *   npm run build-pkg && npm run test-units
 *
 * Runs against the BUILT dist/.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.join(here, '..', 'dist', 'dom-names.js');
if (!fs.existsSync(built)) {
  console.error('check-dom-names: dist/dom-names.js is missing; build first.');
  process.exit(1);
}
const {isDetachedElementName} = await import(pathToFileURL(built).href);

test('DOM nodes, including doctype and processing instructions', () => {
  for (const name of [
    'Detached <div class="x">',
    'Detached Text',
    'Detached Comment',
    'Detached DocumentType',
    'Detached ProcessingInstruction',
    'Detached HTMLDocument',
    'Detached Document',
    'Detached HTMLDivElement',
    'Detached SVGPathElement',
  ]) {
    assert.equal(isDetachedElementName(name), true, name);
  }
});

test('Blink records attached to a node', () => {
  for (const name of [
    'Detached blink::NodeRareData',
    'Detached SVGAnimatedLength',
    'Detached CSSStyleDeclaration',
    'Detached DocumentTypeish',
  ]) {
    assert.equal(isDetachedElementName(name), false, name);
  }
});
