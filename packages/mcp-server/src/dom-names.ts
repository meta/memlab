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
 * A DOM node (`Detached <div …>`, `Detached Text`) rather than one of the
 * Blink records that hang off it (`Detached blink::NodeRareData`,
 * `Detached SVGAnimatedLength`, …). The records move with their element, so
 * counting them as stranded nodes overstates what a leak left behind.
 */
export function isDetachedElementName(name: string): boolean {
  const n = name.replace(/^Detached\s+/, '');
  return (
    n.startsWith('<') ||
    /^(Text|Comment|CDATASection|ProcessingInstruction|DocumentFragment|DocumentType|ShadowRoot|Attr|(HTML|XML)?Document)\b/.test(
      n,
    ) ||
    /^(HTML|SVG|MathML)\w*Element\b/.test(n)
  );
}
