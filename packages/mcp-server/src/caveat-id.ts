/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import crypto from 'crypto';

/**
 * Counts in a caveat (scanned 12/40, 3 prop(s)) vary per round; the text does
 * not. Digits inside a name (`web_memlab_fixes_4`) are kept: a new prop is a
 * new caveat.
 */
export function caveatKey(caveat: string): string {
  return caveat.replace(/(?<![A-Za-z0-9_])\d+(\.\d+)?/g, '#');
}

/**
 * A short, stable id for a caveat, the same in every round of a sweep: an
 * unchanged caveat is referenced by it after the first round, not reprinted.
 */
export function caveatId(caveat: string): string {
  return crypto
    .createHash('sha1')
    .update(caveatKey(caveat))
    .digest('hex')
    .slice(0, 6);
}

/** `#a1b2c3 DEAD PROP: web_x is read by no…`: a caveat by id, cut short. */
export function caveatRef(caveat: string, width = 70): string {
  const text =
    caveat.length > width ? `${caveat.slice(0, width - 1)}…` : caveat;
  return `\`#${caveatId(caveat)}\` ${text}`;
}
