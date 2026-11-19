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
import {getFiberNodeFromElement} from '../utils/react-fiber-utils';
import type {Nullable} from './types';
import {WeakMapPlus} from '../utils/weak-ref-utils';

type EventListenerEntry = {
  type: string;
  cb: WeakRef<EventListenerOrEventListenerObject>;
  capture: boolean;
  fiber?: WeakRef<Fiber>;
};

// The DOM identifies a listener by its type, callback and capture flag;
// every other option is ignored when matching.
function getCapture(options?: boolean | EventListenerOptions): boolean {
  return typeof options === 'boolean' ? options : Boolean(options?.capture);
}

function isSameListener(
  entry: EventListenerEntry,
  type: string,
  listener: EventListenerOrEventListenerObject,
  capture: boolean,
): boolean {
  return (
    entry.type === type &&
    entry.capture === capture &&
    entry.cb.deref() === listener
  );
}

type DetachedListenerGroup = {
  type: string;
  count: number;
  entries: WeakRef<EventListenerEntry>[];
};

export class EventListenerTracker {
  private static instance: EventListenerTracker | null = null;
  #listenerMap: WeakMapPlus<EventTarget, EventListenerEntry[]>;
  #detachedListeners: Map<string, DetachedListenerGroup[]>;
  #originalAddEventListener: typeof EventTarget.prototype.addEventListener;
  #originalRemoveEventListener: typeof EventTarget.prototype.removeEventListener;

  private constructor() {
    this.#listenerMap = new WeakMapPlus({fallback: 'noop', cleanupMs: 100});
    this.#detachedListeners = new Map();
    this.#originalAddEventListener = EventTarget.prototype.addEventListener;
    this.#originalRemoveEventListener =
      EventTarget.prototype.removeEventListener;
    this.#patchEventListeners();
  }

  static getInstance(): EventListenerTracker {
    if (!EventListenerTracker.instance) {
      EventListenerTracker.instance = new EventListenerTracker();
    }
    return EventListenerTracker.instance;
  }

  #patchEventListeners(): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    EventTarget.prototype.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      self.#originalAddEventListener.call(this, type, listener, options);
      // a null listener is valid and the browser ignores it
      if (listener != null && this instanceof Element) {
        const capture = getCapture(options);
        const optionsObject = typeof options === 'object' ? options : null;
        // the browser does not add a listener whose signal is already aborted
        if (optionsObject?.signal?.aborted) {
          return;
        }
        const listeners = self.#listenerMap.get(this) ?? [];
        // the browser ignores a listener that is already registered
        if (listeners.some(e => isSameListener(e, type, listener, capture))) {
          return;
        }
        const fiber = getFiberNodeFromElement(this);
        const entry: EventListenerEntry = {
          type,
          cb: new WeakRef(listener),
          capture,
          fiber: fiber ? new WeakRef(fiber) : undefined,
        };
        listeners.push(entry);
        self.#listenerMap.set(this, listeners);
        self.#forgetWhenBrowserRemoves(this, entry, optionsObject);
      }
    };

    EventTarget.prototype.removeEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) {
      self.#originalRemoveEventListener.call(this, type, listener, options);
      if (this instanceof Element) {
        const listeners = self.#listenerMap.get(this);
        if (listeners) {
          const capture = getCapture(options);
          const index = listeners.findIndex(entry =>
            isSameListener(entry, type, listener, capture),
          );
          if (index !== -1) {
            listeners.splice(index, 1);
          }
          if (listeners.length === 0) {
            self.#listenerMap.delete(this);
          } else {
            self.#listenerMap.set(this, listeners);
          }
        }
      }
    };
  }

  // The browser removes a `once` listener after it runs and a listener whose
  // `signal` aborts, without a removeEventListener call to observe.
  #forgetWhenBrowserRemoves(
    target: Element,
    entry: EventListenerEntry,
    options: Nullable<AddEventListenerOptions>,
  ): void {
    if (options == null) {
      return;
    }
    const targetRef = new WeakRef(target);
    const forget = () => this.#forgetEntry(targetRef, entry);
    if (options.once) {
      // added after the app's listener, so it runs right after it
      this.#originalAddEventListener.call(target, entry.type, forget, {
        capture: entry.capture,
        once: true,
      });
    }
    if (options.signal != null) {
      this.#originalAddEventListener.call(options.signal, 'abort', forget, {
        once: true,
      });
    }
  }

  #forgetEntry(targetRef: WeakRef<Element>, entry: EventListenerEntry): void {
    const target = targetRef.deref();
    if (target == null) {
      return;
    }
    const listeners = this.#listenerMap.get(target);
    if (listeners == null) {
      return;
    }
    const index = listeners.indexOf(entry);
    if (index !== -1) {
      listeners.splice(index, 1);
    }
    if (listeners.length === 0) {
      this.#listenerMap.delete(target);
    }
  }

  #unpatchEventListeners(): void {
    EventTarget.prototype.addEventListener = this.#originalAddEventListener;
    EventTarget.prototype.removeEventListener =
      this.#originalRemoveEventListener;
  }

  addListener(
    el: EventTarget,
    type: string,
    cb: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    el.addEventListener(type, cb, options);
  }

  removeListener(
    el: EventTarget,
    type: string,
    cb: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    el.removeEventListener(type, cb, options);
  }

  scan(
    getComponentName: (elRef: WeakRef<Element>) => string,
  ): Map<string, DetachedListenerGroup[]> {
    const detachedListeners = new Map<string, DetachedListenerGroup[]>();

    for (const [el, listeners] of this.#listenerMap.entries()) {
      if (el instanceof Element && !el.isConnected) {
        for (const listener of listeners) {
          // Skip if the callback has been garbage collected
          if (!listener.cb.deref()) continue;

          const componentName = getComponentName(new WeakRef(el));
          if (!detachedListeners.has(componentName)) {
            detachedListeners.set(componentName, []);
          }

          const groups = detachedListeners.get(componentName);
          let group = groups?.find(g => g.type === listener.type);
          if (!group) {
            group = {
              type: listener.type,
              count: 0,
              entries: [],
            };
            groups?.push(group);
          }
          group.count++;
          group.entries.push(new WeakRef(listener));
        }
      }
    }

    this.#detachedListeners = detachedListeners;
    return detachedListeners;
  }

  getDetachedListeners(): Map<string, DetachedListenerGroup[]> {
    return this.#detachedListeners;
  }

  destroy(): void {
    this.#unpatchEventListeners();
    this.#listenerMap.destroy();
    this.#detachedListeners.clear();
    EventListenerTracker.instance = null;
  }
}
