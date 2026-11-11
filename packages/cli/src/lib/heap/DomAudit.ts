/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapSnapshot} from '@memlab/core';

export type DomBucket = {
  key: string;
  count: number;
  selfSize: number;
};

export type DomAudit = {
  attached: number;
  attachedSelfSize: number;
  detached: number;
  /** Per-element Blink data: computed styles, element data, rare data. */
  sideDataCount: number;
  sideDataSize: number;
  byTag: DomBucket[];
  /** Elements repeated at least `minRepeat` times, most repeated first. */
  repeated: DomBucket[];
};

export type ElementFacts = {
  tag: string;
  /** What groups "the same element, repeated": tag plus test id or classes. */
  signature: string;
};

const SIDE_DATA_PREFIXES = [
  'blink::UniqueElementData',
  'blink::ShareableElementData',
  'blink::NodeRareData',
  'blink::ComputedStyle',
  'ElementIntersectionObserverData',
];

// Tags without a layout box: they count toward the element total, but
// virtualizing them saves nothing.
const NON_RENDERED_TAGS = new Set([
  'script',
  'link',
  'meta',
  'style',
  'title',
  'head',
  'base',
  'noscript',
  'template',
]);

const MAX_SIGNATURE_CLASSES = 6;

/**
 * Whether a heap node is a DOM element attached to the document. Elements
 * are named by their markup (`<div class="x">`), except SVG and some HTML
 * elements, which are named by their interface (`SVGPathElement`).
 */
export function isAttachedElement(node: {type: string; name: string}): boolean {
  if (node.type !== 'native' || node.name.startsWith('Detached ')) {
    return false;
  }
  return (
    node.name.startsWith('<') || /^(?:SVG|HTML)\w*Element$/.test(node.name)
  );
}

function isDetachedElement(node: {type: string; name: string}): boolean {
  return (
    node.type === 'native' &&
    /^Detached (?:<|SVG\w*Element|HTML\w*Element)/.test(node.name)
  );
}

export function describeElement(name: string): ElementFacts {
  const markup = name.match(/^<([A-Za-z0-9-]+)/);
  const idl = name.match(/^(?:SVG|HTML)(\w*)Element$/);
  const tag = markup
    ? markup[1].toLowerCase()
    : idl
      ? `svg:${(idl[1] || 'svg').toLowerCase()}`
      : '?';
  const testId = name.match(/data-testid="([^"]*)"/)?.[1];
  const classes = (name.match(/class="([^"]*)"/)?.[1] ?? '').trim();
  const signature =
    testId != null
      ? `${tag}[data-testid="${testId}"]`
      : classes !== ''
        ? `${tag}.${classes.split(/\s+/).slice(0, MAX_SIGNATURE_CLASSES).join('.')}`
        : tag;
  return {tag, signature};
}

function bump(map: Map<string, DomBucket>, key: string, size: number): void {
  const bucket = map.get(key);
  if (bucket != null) {
    bucket.count++;
    bucket.selfSize += size;
  } else {
    map.set(key, {key, count: 1, selfSize: size});
  }
}

function byCount(map: Map<string, DomBucket>): DomBucket[] {
  return [...map.values()].sort(
    (a, b) =>
      b.count - a.count ||
      b.selfSize - a.selfSize ||
      a.key.localeCompare(b.key),
  );
}

/**
 * How many DOM elements a browser heap snapshot holds attached to the
 * document, by tag and by repeated element. A long list of identical
 * elements costs style and layout work on every recalculation whether or
 * not it is on screen, which is what list virtualization saves.
 */
export function auditDom(snapshot: IHeapSnapshot, minRepeat: number): DomAudit {
  const byTag = new Map<string, DomBucket>();
  const bySignature = new Map<string, DomBucket>();
  let attached = 0;
  let attachedSelfSize = 0;
  let detached = 0;
  let sideDataCount = 0;
  let sideDataSize = 0;
  snapshot.nodes.forEach(node => {
    if (node.type !== 'native') {
      return;
    }
    if (SIDE_DATA_PREFIXES.some(prefix => node.name.startsWith(prefix))) {
      sideDataCount++;
      sideDataSize += node.self_size;
      return;
    }
    if (isDetachedElement(node)) {
      detached++;
      return;
    }
    if (!isAttachedElement(node)) {
      return;
    }
    attached++;
    attachedSelfSize += node.self_size;
    const facts = describeElement(node.name);
    bump(byTag, facts.tag, node.self_size);
    if (!NON_RENDERED_TAGS.has(facts.tag)) {
      bump(bySignature, facts.signature, node.self_size);
    }
  });
  return {
    attached,
    attachedSelfSize,
    detached,
    sideDataCount,
    sideDataSize,
    byTag: byCount(byTag),
    repeated: byCount(bySignature).filter(b => b.count >= minRepeat),
  };
}
