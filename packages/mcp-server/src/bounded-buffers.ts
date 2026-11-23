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
 * Browser buffers with a fixed capacity: growth that stops at the cap is the
 * buffer filling, not a leak. Capacities are the specs' and Chromium's
 * defaults, per document.
 */
export const BOUNDED_BUFFERS: ReadonlyMap<string, {cap: number; what: string}> =
  new Map([
    ['PerformanceEventTiming', {cap: 150, what: 'Event Timing buffer'}],
    ['LayoutShift', {cap: 150, what: 'Layout Instability buffer'}],
    [
      'LayoutShiftAttribution',
      {cap: 750, what: 'Layout Instability buffer (5 sources per shift)'},
    ],
    ['LargestContentfulPaint', {cap: 150, what: 'LCP buffer'}],
    ['PerformanceResourceTiming', {cap: 250, what: 'Resource Timing buffer'}],
    ['PerformanceLongTaskTiming', {cap: 200, what: 'Long Tasks buffer'}],
    ['PerformanceLongAnimationFrameTiming', {cap: 200, what: 'LoAF buffer'}],
    // Chromium's ConsoleMessageStorage keeps the last 1,000 messages for
    // DevTools, each with its source location.
    ['blink::ConsoleMessage', {cap: 1000, what: 'console message storage'}],
    [
      'blink::SourceLocation',
      {cap: 1000, what: 'console message storage (one location per message)'},
    ],
  ]);

/** The capped buffer instances of class `name` fill, if any. */
export function boundedBuffer(
  name: string,
): {cap: number; what: string} | undefined {
  return BOUNDED_BUFFERS.get(name.trim());
}

/**
 * A population of a capped buffer that has not passed its cap, and when it
 * reaches it: `{count, cap, saturatesAtCycle}` (null once full or when the
 * rate is unknown), or null when the class is not a capped buffer or is
 * above the cap (something else holds it too).
 */
export function boundedFill(
  name: string,
  base: number,
  count: number,
  cycles: number | null,
): {cap: number; what: string; saturatesAtCycle: number | null} | null {
  const buf = boundedBuffer(name);
  if (buf == null || count > buf.cap * 1.1) return null;
  const rate = cycles != null && cycles > 0 ? (count - base) / cycles : 0;
  const saturatesAtCycle =
    count >= buf.cap || rate <= 0 ? null : Math.ceil((buf.cap - base) / rate);
  return {...buf, saturatesAtCycle};
}
