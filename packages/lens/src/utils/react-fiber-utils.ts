/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import type {Fiber} from 'react-reconciler';
import type {Nullable, Optional, AnyValue} from '../core/types';
import {getMeaningfulName} from './utils';
import {isValidComponentName} from '../core/valid-component-name';

export const ClassComponentTag = 1;
export const FunctionComponentTag = 0;
export const ContextConsumerTag = 9;
export const SuspenseComponentTag = 13;
export const OffscreenComponentTag = 22;
export const ForwardRefTag = 11;
export const MemoComponentTag = 14;
export const SimpleMemoComponentTag = 15;
export const HostComponentTag = 5;
export const HostHoistableTag = 26;
export const HostSingletonTag = 27;
export const DehydratedSuspenseComponent = 18;
export const HostText = 6;
export const Fragment = 7;
export const LegacyHiddenComponent = 23;
export const OffscreenComponent = 22;
export const HostRoot = 3;
export const CONCURRENT_MODE_NUMBER = 0xeacf;
export const CONCURRENT_MODE_SYMBOL_STRING = 'Symbol(react.concurrent_mode)';
export const DEPRECATED_ASYNC_MODE_SYMBOL_STRING = 'Symbol(react.async_mode)';

// https://github.com/facebook/react/blob/main/packages/react-reconciler/src/ReactFiberFlags.js
export const PerformedWork = 0b1;
export const Placement = 0b10;
export const DidCapture = 0b10000000;
export const Hydrating = 0b1000000000000;
export const Update = 0b100;
export const Cloned = 0b1000;
export const ChildDeletion = 0b10000;
export const ContentReset = 0b100000;
export const Ref = 0b1000000000;
export const Snapshot = 0b10000000000;
export const Visibility = 0b10000000000000;
export const MutationMask =
  Placement |
  Update |
  ChildDeletion |
  ContentReset |
  Hydrating |
  Visibility |
  Snapshot;

/**
 * @see https://reactnative.dev/architecture/glossary#host-view-tree-and-host-view
 */
export const isHostFiber = (fiber: Fiber) =>
  fiber.tag === HostComponentTag ||
  // @ts-expect-error: it exists
  fiber.tag === HostHoistableTag ||
  // @ts-expect-error: it exists
  fiber.tag === HostSingletonTag ||
  typeof fiber.type === 'string';

export const getNearestHostFiber = (fiber: Fiber) => {
  let hostFiber = traverseFiber(fiber, isHostFiber);
  if (!hostFiber) {
    hostFiber = traverseFiber(fiber, isHostFiber, true);
  }
  return hostFiber;
};

export const getTopMostHostFiber = (fiber: Fiber): Nullable<Fiber> => {
  let topMostHostFiber: Nullable<Fiber> = null;
  function checkFiber(fiber: Fiber): void {
    if (isHostFiber(fiber)) {
      topMostHostFiber = fiber;
    }
  }
  traverseFiber(fiber, checkFiber, true);
  return topMostHostFiber;
};

export const traverseFiber = (
  fiber: Nullable<Fiber>,
  selector: (node: Fiber) => boolean | void,
  ascending = false,
): Nullable<Fiber> => {
  if (!fiber) {
    return null;
  }
  if (selector(fiber) === true) {
    return fiber;
  }

  let next = ascending ? fiber.return : fiber.child;
  while (next) {
    const match = traverseFiber(next, selector, ascending);
    if (match) {
      return match;
    }
    next = ascending ? null : next.sibling;
  }
  return null;
};

/**
 * Returns the current HostRoot fiber of the tree `fiber` belongs to, or null
 * when `fiber` is in a subtree that is no longer attached to a root.
 * A DOM element keeps the fiber it was created with, which after a re-render
 * may belong to the alternate tree, so walking up from it can reach the
 * alternate HostRoot; the FiberRoot always points at the current one.
 */
export function getCurrentHostRootFiber(fiber: Fiber): Nullable<Fiber> {
  const visited = new Set<Fiber>();
  let top: Fiber = fiber;
  while (top.return != null && !visited.has(top.return)) {
    visited.add(top);
    top = top.return;
  }
  if (top.tag !== HostRoot) {
    return null;
  }
  return top.stateNode?.current ?? top;
}

/**
 * Returns the React FiberRoot whose container is `element`, or null when the
 * element is not a React root container. `createRoot()` and `render()` mark
 * the container with `__reactContainer$<id>` (the HostRoot fiber it was
 * created with), and `render()` also sets `_reactRootContainer`.
 */
export function getFiberRootOfContainer(element: Element): AnyValue {
  for (const key of Object.getOwnPropertyNames(element)) {
    if (key.startsWith('__reactContainer$')) {
      return (element as AnyValue)[key]?.stateNode ?? null;
    }
    if (key === '_reactRootContainer') {
      const container = (element as AnyValue)[key];
      return container?._internalRoot ?? container ?? null;
    }
  }
  return null;
}

/**
 * Depth-first walk of the fiber tree below `root`, in child order.
 * `visit` returns false to skip the fiber's subtree; the walk then goes on
 * with the next sibling.
 */
export function walkFiberTree(
  root: Fiber,
  visit: (fiber: Fiber) => boolean,
): void {
  const seen = new Set<Fiber>();
  const stack: Fiber[] = [root];
  while (stack.length > 0) {
    const fiber = stack.pop();
    if (fiber == null || seen.has(fiber)) {
      continue;
    }
    seen.add(fiber);
    // push the sibling first so that the child's subtree is walked before it
    if (fiber !== root && fiber.sibling != null) {
      stack.push(fiber.sibling);
    }
    if (visit(fiber) && fiber.child != null) {
      stack.push(fiber.child);
    }
  }
}

// React internal property keys
const internalKeys = [
  '__reactFiber$', // React 17+
  '__reactInternalInstance$', // React 16
  '_reactRootContainer', // React Root
];

const getOwnPropertyNames = Object.getOwnPropertyNames.bind(Object);

export function getFiberNodeFromElement(element: Element) {
  for (const prefix of internalKeys) {
    // Use Object.keys only as fallback since it's slower
    const key = getOwnPropertyNames(element).find(k => k.startsWith(prefix));

    if (key) {
      return (element as AnyValue)[key];
    }
  }
  return null;
}

export function getReactComponentStack(node: Fiber): Array<string> {
  const stack = [];
  const visited = new Set<Fiber>();
  let fiber: Nullable<Fiber> = node;
  while (fiber) {
    if (visited.has(fiber)) {
      break;
    }
    visited.add(fiber);
    const name = getDisplayNameOfFiberNode(fiber);
    if (name) {
      stack.push(name);
    }
    fiber = fiber.return;
  }
  return stack;
}

export function getDisplayNameOfFiberNode(node: Fiber) {
  const elementType = node.type ?? node.elementType;

  // Try to get name from displayName or name properties
  let displayName: Optional<string> =
    elementType?.displayName ?? elementType?.name;

  // Handle class components and forwardRef
  if (displayName == null) {
    if (elementType?.render) {
      // Class components
      const render = elementType?.render;
      displayName = render?.displayName ?? render?.name;
    } else if (elementType?.type) {
      // ForwardRef components
      displayName = elementType.type.displayName ?? elementType.type.name;
    }
  }

  // Handle anonymous functions
  if (!displayName && typeof elementType === 'function') {
    displayName = elementType.name;
  }
  const ret = getMeaningfulName(extractReactComponentName(displayName));
  return isValidComponentName(ret) ? ret : null;
}

export function isFunctionalComponent(node: Fiber) {
  const elementType = node?.elementType;
  return typeof elementType === 'function';
}

// dom-element [from component.react] --> component.react
export function extractReactComponentName(
  displayName: Optional<string>,
): Nullable<string> {
  if (typeof displayName !== 'string') {
    return null;
  }
  if (!displayName.includes('[') || !displayName.includes(']')) {
    return displayName;
  }
  const startIndex = displayName.indexOf('[');
  const endIndex = displayName.indexOf(']');
  if (startIndex > endIndex) {
    return displayName;
  }
  const name = displayName.substring(startIndex + 1, endIndex);
  if (name.startsWith('from ')) {
    return name.substring('from '.length);
  }
  return name;
}
