/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {getTerminalType} from '../../../commands/heap/interactive/ui-components/HeapViewUtils';

test('Windows 10+ consoles are described as xterm-256color', () => {
  expect(getTerminalType('win32', {}, '10.0.19045')).toBe('xterm-256color');
  expect(getTerminalType('win32', {}, '10.0.10586')).toBe('xterm-256color');
});

test('older Windows consoles and set TERMs are left to blessed', () => {
  // before Windows 10 build 10586, consoles have no xterm escape sequences
  expect(getTerminalType('win32', {}, '10.0.10240')).toBeUndefined();
  expect(getTerminalType('win32', {}, '6.3.9600')).toBeUndefined();
  // e.g. Git Bash, WSL, or ssh set TERM themselves
  expect(
    getTerminalType('win32', {TERM: 'xterm'}, '10.0.19045'),
  ).toBeUndefined();
  expect(getTerminalType('linux', {}, '6.8.0')).toBeUndefined();
  expect(getTerminalType('darwin', {}, '24.0.0')).toBeUndefined();
});
