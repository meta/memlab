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
import type {GlobalListenerSite, GlobalListenerTarget, Nullable} from './types';
import {WeakMapPlus} from '../utils/weak-ref-utils';

type EventListenerEntry = {
  type: string;
  cb: WeakRef<EventListenerOrEventListenerObject>;
  capture: boolean;
  fiber?: WeakRef<Fiber>;
  site?: string;
};

function getGlobalTargetName(
  target: EventTarget,
): Nullable<GlobalListenerTarget> {
  if (typeof window !== 'undefined' && target === window) {
    return 'window';
  }
  if (typeof document !== 'undefined' && target === document) {
    return 'document';
  }
  return null;
}

// The first stack frame outside MemLens: [0] is the message, [1] this
// function, [2] #recordAdd, [3] the addEventListener wrapper, [4] its caller.
function getCallSite(): string {
  const frames = new Error().stack?.split('\n') ?? [];
  return frames[4]?.trim().replace(/^at /, '') ?? '<unknown>';
}

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
  // listeners on window and document, which outlive every component, so a
  // listener added on mount and not removed on unmount accumulates here
  #globalListeners: Map<EventTarget, EventListenerEntry[]> = new Map();
  #detachedListeners: Map<string, DetachedListenerGroup[]>;
  #originalAddEventListener: typeof EventTarget.prototype.addEventListener;
  #originalRemoveEventListener: typeof EventTarget.prototype.removeEventListener;
  #patchedAddEventListener: Nullable<
    typeof EventTarget.prototype.addEventListener
  > = null;
  #patchedRemoveEventListener: Nullable<
    typeof EventTarget.prototype.removeEventListener
  > = null;
  #isActive = true;
  #refCount = 0;

  private constructor() {
    this.#listenerMap = new WeakMapPlus({fallback: 'noop', cleanupMs: 100});
    this.#detachedListeners = new Map();
    this.#originalAddEventListener = EventTarget.prototype.addEventListener;
    this.#originalRemoveEventListener =
      EventTarget.prototype.removeEventListener;
    this.#patchEventListeners();
  }

  /**
   * Returns the shared tracker. Every acquire() must be paired with one
   * release(); the tracker is destroyed when the last user releases it.
   */
  static acquire(): EventListenerTracker {
    if (!EventListenerTracker.instance) {
      EventListenerTracker.instance = new EventListenerTracker();
    }
    ++EventListenerTracker.instance.#refCount;
    return EventListenerTracker.instance;
  }

  release(): void {
    if (--this.#refCount <= 0) {
      this.destroy();
    }
  }

  #patchEventListeners(): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    EventTarget.prototype.addEventListener = this.#patchedAddEventListener =
      function (
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        self.#originalAddEventListener.call(this, type, listener, options);
        // a MemLens failure must never break the app's call
        try {
          self.#recordAdd(this, type, listener, options);
        } catch {
          // ignore
        }
      };

    EventTarget.prototype.removeEventListener =
      this.#patchedRemoveEventListener = function (
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ) {
        self.#originalRemoveEventListener.call(this, type, listener, options);
        try {
          self.#recordRemove(this, type, listener, options);
        } catch {
          // ignore
        }
      };
  }

  #recordAdd(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    // a null listener is valid and the browser ignores it
    if (!this.#isActive || listener == null || !this.#isTracked(target)) {
      return;
    }
    const capture = getCapture(options);
    const optionsObject = typeof options === 'object' ? options : null;
    // the browser does not add a listener whose signal is already aborted
    if (optionsObject?.signal?.aborted) {
      return;
    }
    const listeners = this.#getListeners(target) ?? [];
    // the browser ignores a listener that is already registered
    if (listeners.some(e => isSameListener(e, type, listener, capture))) {
      return;
    }
    const entry: EventListenerEntry = {
      type,
      cb: new WeakRef(listener),
      capture,
    };
    if (target instanceof Element) {
      const fiber = getFiberNodeFromElement(target);
      entry.fiber = fiber ? new WeakRef(fiber) : undefined;
    } else {
      entry.site = getCallSite();
    }
    listeners.push(entry);
    this.#setListeners(target, listeners);
    this.#forgetWhenBrowserRemoves(target, entry, optionsObject);
  }

  #recordRemove(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    if (!this.#isActive || !this.#isTracked(target)) {
      return;
    }
    const capture = getCapture(options);
    const entry = this.#getListeners(target)?.find(e =>
      isSameListener(e, type, listener, capture),
    );
    if (entry != null) {
      this.#forgetEntry(new WeakRef(target), entry);
    }
  }

  // The browser removes a `once` listener after it runs and a listener whose
  // `signal` aborts, without a removeEventListener call to observe.
  #forgetWhenBrowserRemoves(
    target: EventTarget,
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

  #forgetEntry(
    targetRef: WeakRef<EventTarget>,
    entry: EventListenerEntry,
  ): void {
    const target = targetRef.deref();
    if (target == null) {
      return;
    }
    const listeners = this.#getListeners(target);
    if (listeners == null) {
      return;
    }
    const index = listeners.indexOf(entry);
    if (index !== -1) {
      listeners.splice(index, 1);
    }
    if (listeners.length === 0) {
      this.#deleteListeners(target);
    }
  }

  #isTracked(target: EventTarget): boolean {
    return target instanceof Element || getGlobalTargetName(target) != null;
  }

  #getListeners(target: EventTarget): EventListenerEntry[] | undefined {
    return target instanceof Element
      ? this.#listenerMap.get(target)
      : this.#globalListeners.get(target);
  }

  #setListeners(target: EventTarget, listeners: EventListenerEntry[]): void {
    if (target instanceof Element) {
      this.#listenerMap.set(target, listeners);
    } else {
      this.#globalListeners.set(target, listeners);
    }
  }

  #deleteListeners(target: EventTarget): void {
    if (target instanceof Element) {
      this.#listenerMap.delete(target);
    } else {
      this.#globalListeners.delete(target);
    }
  }

  /**
   * Live listeners on window and document, grouped by target, type and the
   * call site that added them, largest groups first.
   */
  getGlobalListenerSites(): GlobalListenerSite[] {
    const sites = new Map<string, GlobalListenerSite>();
    for (const [target, listeners] of this.#globalListeners) {
      const targetName = getGlobalTargetName(target);
      if (targetName == null) {
        continue;
      }
      for (const listener of listeners) {
        if (listener.cb.deref() == null) {
          continue;
        }
        const site = listener.site ?? '<unknown>';
        const key = `${targetName}\u0000${listener.type}\u0000${site}`;
        const group = sites.get(key);
        if (group != null) {
          ++group.count;
        } else {
          sites.set(key, {
            target: targetName,
            type: listener.type,
            site,
            count: 1,
          });
        }
      }
    }
    return [...sites.values()].sort((a, b) => b.count - a.count);
  }

  #unpatchEventListeners(): void {
    // Code that patched these methods after MemLens calls through to the
    // MemLens wrappers. Restoring the originals would drop its patch, so in
    // that case the wrappers stay in place and only stop tracking.
    if (
      EventTarget.prototype.addEventListener === this.#patchedAddEventListener
    ) {
      EventTarget.prototype.addEventListener = this.#originalAddEventListener;
    }
    if (
      EventTarget.prototype.removeEventListener ===
      this.#patchedRemoveEventListener
    ) {
      EventTarget.prototype.removeEventListener =
        this.#originalRemoveEventListener;
    }
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
    this.#isActive = false;
    this.#refCount = 0;
    this.#unpatchEventListeners();
    this.#listenerMap.destroy();
    this.#globalListeners.clear();
    this.#detachedListeners.clear();
    EventListenerTracker.instance = null;
  }
}
