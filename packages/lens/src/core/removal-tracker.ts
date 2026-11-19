/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import type {AnyValue} from './types';
import {isVisualizerElement} from '../visual/visual-utils';

export type BeforeRemoveCallback = (elements: Element[]) => void;

// elements reported per removal; a larger subtree is cut off at this size
const MAX_ELEMENTS_PER_REMOVAL = 5000;

type Patch = {
  target: object;
  key: string;
  original: PropertyDescriptor;
  patched: PropertyDescriptor;
};

function collectElements(nodes: Iterable<Node>, out: Element[]): void {
  const stack: Node[] = [...nodes];
  while (stack.length > 0 && out.length < MAX_ELEMENTS_PER_REMOVAL) {
    const node = stack.pop();
    if (node == null || node.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }
    const element = node as Element;
    if (isVisualizerElement(element)) {
      continue;
    }
    out.push(element);
    for (let child = element.lastElementChild; child;) {
      stack.push(child);
      child = child.previousElementSibling;
    }
  }
}

/**
 * Calls back with the elements a DOM call is about to detach, while they are
 * still attached: their position on screen and their React fiber are only
 * readable before the removal (React drops the fiber reference from a removed
 * element in its passive effects). Covers the DOM methods that remove nodes
 * (removeChild, replaceChild, remove, replaceWith, replaceChildren) and the
 * innerHTML, outerHTML and textContent setters.
 */
export class RemovalTracker {
  #callback: BeforeRemoveCallback | null;
  #patches: Patch[] = [];
  #isReporting = false;

  constructor(callback: BeforeRemoveCallback) {
    this.#callback = callback;
  }

  install(): void {
    if (this.#patches.length > 0 || typeof Node === 'undefined') {
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const childrenOf = (node: Node): Node[] => Array.from(node.childNodes);
    const removing: Array<
      [object, string, (self: AnyValue, args: AnyValue[]) => Node[]]
    > = [
      [Node.prototype, 'removeChild', (_, [child]) => [child]],
      [Node.prototype, 'replaceChild', (_, [, oldChild]) => [oldChild]],
      [Element.prototype, 'remove', node => [node]],
      [Element.prototype, 'replaceWith', node => [node]],
      [Element.prototype, 'replaceChildren', node => childrenOf(node)],
    ];
    for (const [target, key, getRemoved] of removing) {
      const original = Object.getOwnPropertyDescriptor(target, key);
      const method = original?.value;
      if (typeof method !== 'function') {
        continue;
      }
      const patched = {
        ...original,
        value: function (this: AnyValue, ...args: AnyValue[]) {
          self.#report(() => getRemoved(this, args));
          return method.apply(this, args);
        },
      };
      this.#apply({
        target,
        key,
        original: original as PropertyDescriptor,
        patched,
      });
    }
    const replacingSetters: Array<
      [object, string, (node: AnyValue) => Node[]]
    > = [
      [Element.prototype, 'innerHTML', node => childrenOf(node)],
      [Element.prototype, 'outerHTML', node => [node]],
      [Node.prototype, 'textContent', node => childrenOf(node)],
    ];
    for (const [target, key, getRemoved] of replacingSetters) {
      const original = Object.getOwnPropertyDescriptor(target, key);
      const setter = original?.set;
      if (original == null || setter == null) {
        continue;
      }
      const patched = {
        ...original,
        set(this: AnyValue, value: AnyValue) {
          self.#report(() => getRemoved(this));
          setter.call(this, value);
        },
      };
      this.#apply({target, key, original, patched});
    }
  }

  uninstall(): void {
    for (const patch of this.#patches) {
      // leave a patch installed on top of ours in place; ours stays inert
      const current = Object.getOwnPropertyDescriptor(patch.target, patch.key);
      if (
        current?.value === patch.patched.value &&
        current?.set === patch.patched.set
      ) {
        Object.defineProperty(patch.target, patch.key, patch.original);
      }
    }
    this.#patches = [];
    this.#callback = null;
  }

  #apply(patch: Patch): void {
    Object.defineProperty(patch.target, patch.key, patch.patched);
    this.#patches.push(patch);
  }

  #report(getRemoved: () => Node[]): void {
    // ignore DOM calls made by the callback itself
    if (this.#isReporting) {
      return;
    }
    this.#isReporting = true;
    try {
      const nodes = getRemoved().filter(node => node?.isConnected);
      if (nodes.length > 0) {
        const elements: Element[] = [];
        collectElements(nodes, elements);
        if (elements.length > 0) {
          this.#callback?.(elements);
        }
      }
    } catch {
      // never let MemLens break the app's DOM call
    } finally {
      this.#isReporting = false;
    }
  }
}
