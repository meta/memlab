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
import type {
  AnalysisResult,
  AnalysisResultCallback,
  BoundingRect,
  CreateOptions,
  DOMElementInfo,
  Optional,
  ScanResult,
  AnyValue,
  EventListenerLeak,
  GlobalListenerGrowth,
  MemLensReport,
  Nullable,
  ReportedDetachedElement,
} from './types';
import type {BasicExtension} from '../extensions/basic-extension';

import * as utils from '../utils/utils';
import ReactFiberAnalyzer from './react-fiber-analysis';
import {
  getDisplayNameOfFiberNode,
  getFiberNodeFromElement,
  getFiberRootOfContainer,
  getReactComponentStack,
} from '../utils/react-fiber-utils';
import {DOMObserver} from './dom-observer';
import {config} from '../config/config';
import {EventListenerTracker} from './event-listener-tracker';
import {GCTracker} from './gc-tracker';
import {collectElements, RemovalTracker} from './removal-tracker';
import {isVisualizerElement} from '../visual/visual-utils';

type DetachedRecord = {
  detachedAt: number;
  gcCountAtDetach: number;
};

type UnmountedFiberRecord = {
  fiber: WeakRef<Fiber>;
  gcCountAtUnmount: number;
};

const DEFAULT_MIN_GC_COUNT = 1;

// Reading a rect forces a layout when the DOM changed since the last one, so
// a commit that removes many nodes one by one would force a layout per
// removal. Rects are read until this much time is spent in one synchronous
// run of removals; the rest keep the rect recorded by an earlier scan.
const REMOVAL_RECT_BUDGET_MS = 4;

// elements whose rect is recorded per animation frame after they are added
const ADDED_RECTS_PER_FRAME = 5000;

export default class ReactMemoryScan {
  static nextElementId = 0;
  #elementWeakRefs: Array<WeakRef<Element>>;
  #isActivated: boolean;
  #intervalId: Nullable<NodeJS.Timeout>;
  #elementToBoundingRects: WeakMap<Element, BoundingRect>;
  #elementToComponentStack: WeakMap<Element, string[]>;
  #knownFiberNodes: Array<WeakRef<Fiber>>;
  #fiberAnalyzer: ReactFiberAnalyzer;
  #isDevMode: boolean;
  #subscribers: Array<AnalysisResultCallback>;
  #extensions: Array<BasicExtension>;
  #scanIntervalMs: number;
  #domObserver: Optional<DOMObserver>;
  #eventListenerTracker: Nullable<EventListenerTracker>;
  #isDisposed: boolean;
  #globalListenerBaseline: Map<string, number> = new Map();
  #gcTracker: GCTracker = new GCTracker();
  #detachedRecords: WeakMap<Element, DetachedRecord> = new WeakMap();
  #detachedElementMinGCCount: number;
  #unmountedFibers: Array<UnmountedFiberRecord> = [];
  #leakedFiberMinGCCount: number;
  #removalTracker: Nullable<RemovalTracker>;
  #removedSinceLastScan: Array<WeakRef<Element>> = [];
  #removalRectTimeMs = 0;
  #isRemovalRectResetQueued = false;
  #reactRoots: Array<WeakRef<AnyValue>> = [];
  #knownReactRoots: WeakSet<object> = new WeakSet();
  #addedSinceLastFrame: Array<WeakRef<Node>> = [];
  #isAddedRectFrameRequested = false;

  constructor(options: CreateOptions = {}) {
    this.#elementWeakRefs = [];
    this.#isActivated = false;
    this.#elementToBoundingRects = new WeakMap();
    this.#elementToComponentStack = new WeakMap();
    this.#knownFiberNodes = [];
    this.#eventListenerTracker = options.trackEventListenerLeaks
      ? EventListenerTracker.acquire()
      : null;
    this.#intervalId = null;
    this.#isDisposed = false;

    this.#fiberAnalyzer = new ReactFiberAnalyzer();
    this.#isDevMode = options.isDevMode ?? false;
    this.#subscribers = options.subscribers ?? [];
    this.#extensions = options.extensions ?? [];
    this.#scanIntervalMs =
      options.scanIntervalMs ?? config.performance.scanIntervalMs;
    // without GC detection every reachable detached element is reported
    this.#detachedElementMinGCCount = this.#gcTracker.isSupported()
      ? (options.detachedElementMinGCCount ?? DEFAULT_MIN_GC_COUNT)
      : 0;
    this.#removalTracker =
      options.captureOnRemoval === false
        ? null
        : new RemovalTracker(elements => this.#recordBeforeRemoval(elements));
    this.#leakedFiberMinGCCount = this.#gcTracker.isSupported()
      ? (options.leakedFiberMinGCCount ?? DEFAULT_MIN_GC_COUNT)
      : 0;
  }

  #log(...args: AnyValue[]): void {
    if (this.#isDevMode && config.features.enableConsoleLogs) {
      utils.consoleLog(...args);
    }
  }

  subscribe(callback: AnalysisResultCallback): () => void {
    this.#subscribers.push(callback);
    return () => this.unsubscribe(callback);
  }

  unsubscribe(callback: AnalysisResultCallback): void {
    this.#subscribers = this.#subscribers.filter(cb => cb !== callback);
  }

  #notifySubscribers(result: AnalysisResult): void {
    for (const subscriber of this.#subscribers) {
      subscriber(result);
    }
    const duration = result.end - result.start;
    this.#log('duration: ', `${duration} ms`);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {scanner, leakedFibers, fiberNodes, ...rest} = result;
    this.#log(rest);
  }

  registerExtension(extension: BasicExtension): () => void {
    this.#extensions.push(extension);
    return () => this.unregisterExtension(extension);
  }

  unregisterExtension(extension: BasicExtension): void {
    this.#extensions = this.#extensions.filter(e => e !== extension);
  }

  #notifyExtensionsBeforeScan(): void {
    for (const extension of this.#extensions) {
      extension?.beforeScan();
    }
  }

  #notifyExtensionsAfterScan(result: AnalysisResult): void {
    for (const extension of this.#extensions) {
      extension?.afterScan(result);
    }
  }

  start() {
    if (this.#isDisposed) {
      console.warn(
        '[Memory] ReactMemoryScan has been disposed and cannot be started again',
      );
      return;
    }

    this.#isActivated = true;
    if (this.#intervalId != null) {
      return;
    }
    this.#removalTracker?.install();
    this.#intervalId = setInterval(
      this.#scanCycle.bind(this),
      this.#scanIntervalMs,
    );
    if (config.features.enableMutationObserver) {
      if (this.#domObserver == null) {
        this.#domObserver = new DOMObserver(records =>
          this.#onMutations(records),
        );
        // NOTE: do not update the fiber or component information here
        // with this.#domObserver.register as those elements in the delta
        // list may be unmounted or just attached and their shape and
        // component info is not correct or not set yet
      }
      this.#domObserver.startMonitoring();
    }
    if (this.#isEventDriven()) {
      this.#sweepOnStart();
    }
    console.log('[Memory] Tracking React and DOM memory...');
  }

  #scanCycle() {
    if (!this.#isActivated) {
      return;
    }
    this.#notifyExtensionsBeforeScan();
    const start = performance.now();
    const stats = this.scan();
    const end = performance.now();

    // inform subscribers and extensions
    const analysiResult = {
      ...stats,
      start,
      end,
      scanner: this,
    };
    this.#notifySubscribers(analysiResult);
    this.#notifyExtensionsAfterScan(analysiResult);
  }

  pause() {
    this.#isActivated = false;
  }

  stop() {
    this.#isActivated = false;

    // Clear the interval
    if (this.#intervalId !== null) {
      clearInterval(this.#intervalId);
      this.#intervalId = null;
    }

    // Clear element references to allow garbage collection
    this.#elementWeakRefs = [];
    this.#knownFiberNodes = [];
    this.#unmountedFibers = [];
    this.#removedSinceLastScan = [];
    this.#addedSinceLastFrame = [];
    this.#reactRoots = [];

    this.#removalTracker?.uninstall();

    // Stop DOM observer
    if (this.#domObserver) {
      this.#domObserver.stopMonitoring();
      this.#domObserver = null;
    }

    // Clear WeakMaps to allow garbage collection
    this.#elementToBoundingRects = new WeakMap();
    this.#elementToComponentStack = new WeakMap();

    console.log('[Memory] ReactMemoryScan stopped');
  }

  dispose() {
    // Stop all monitoring
    this.stop();

    // Clear all subscribers
    this.#subscribers = [];

    // Clean up all extensions
    for (const extension of this.#extensions) {
      if (extension && typeof (extension as AnyValue).cleanup === 'function') {
        (extension as AnyValue).cleanup();
      }
    }
    this.#extensions = [];

    // Dispose event listener tracker if it exists
    if (this.#eventListenerTracker) {
      this.#eventListenerTracker.release();
      this.#eventListenerTracker = null;
    }

    this.#gcTracker.dispose();

    // Mark as disposed to prevent reuse
    this.#isDisposed = true;

    console.log('[Memory] ReactMemoryScan disposed');
  }

  recordBoundingRectangles(elementRefs: Array<WeakRef<Element>>) {
    for (const elemRef of elementRefs) {
      const element = elemRef.deref();
      if (element == null || this.#elementToBoundingRects.has(element)) {
        continue;
      }
      const rect = utils.getBoundingClientRect(element);
      if (rect != null) {
        this.#elementToBoundingRects.set(element, rect);
      }
    }
  }

  // Updates the detached records and returns how many detached elements
  // have survived enough full GCs.
  #updateDetachedRecords(): number {
    const gcCount = this.#gcTracker.getCount();
    let confirmed = 0;
    for (const weakRef of this.#elementWeakRefs) {
      const element = weakRef.deref();
      if (element == null) {
        continue;
      }
      const record = this.#detachedRecords.get(element);
      if (element.isConnected) {
        if (record != null) {
          this.#detachedRecords.delete(element);
        }
      } else if (record == null) {
        this.#detachedRecords.set(element, {
          detachedAt: Date.now(),
          gcCountAtDetach: gcCount,
        });
        if (this.#detachedElementMinGCCount <= 0) {
          ++confirmed;
        }
      } else if (
        gcCount - record.gcCountAtDetach >=
        this.#detachedElementMinGCCount
      ) {
        ++confirmed;
      }
    }
    return confirmed;
  }

  // full GCs the element has survived since MemLens saw it detached
  #getGCSurvivedCount(element: Element): number {
    const record = this.#detachedRecords.get(element);
    if (record == null) {
      return 0;
    }
    return this.#gcTracker.getCount() - record.gcCountAtDetach;
  }

  #isConfirmedDetached(element: Element): boolean {
    return (
      !element.isConnected &&
      this.#getGCSurvivedCount(element) >= this.#detachedElementMinGCCount
    );
  }

  /**
   * Detached elements that are still alive after the configured number of
   * full GCs (`detachedElementMinGCCount`, 1 by default). Pass
   * `includeUnconfirmed` to also get those still waiting for a GC.
   */
  // While the removal tracker runs, removed elements are reported as they
  // leave the DOM, so a scan only has to look at those and walk the React
  // trees from their roots, instead of sweeping the whole DOM.
  #isEventDriven(): boolean {
    return this.#removalTracker?.isInstalled() ?? false;
  }

  // One full pass when tracking starts: find the React roots, and record the
  // rects of the elements already on the page (one layout for all of them).
  #sweepOnStart(): void {
    const domObserver = this.#domObserver;
    const elements = utils.getAllElements(element => {
      const shadowRoot = domObserver?.getShadowRoot(element) ?? null;
      if (shadowRoot != null) {
        domObserver?.observe(shadowRoot);
      }
      return shadowRoot;
    });
    for (const element of elements) {
      if (isVisualizerElement(element)) {
        continue;
      }
      this.#addReactRootOf(element);
      if (!this.#elementToBoundingRects.has(element)) {
        const rect = utils.getBoundingClientRect(element);
        if (rect != null) {
          this.#elementToBoundingRects.set(element, rect);
        }
      }
    }
  }

  #addReactRootOf(container: Element): void {
    const root = getFiberRootOfContainer(container);
    if (root != null && !this.#knownReactRoots.has(root)) {
      this.#knownReactRoots.add(root);
      this.#reactRoots.push(new WeakRef(root));
    }
  }

  #getRootFibers(): Array<Fiber> {
    const rootFibers: Array<Fiber> = [];
    this.#reactRoots = this.#reactRoots.filter(ref => {
      const current = ref.deref()?.current;
      if (current != null) {
        rootFibers.push(current);
      }
      return ref.deref() != null;
    });
    return rootFibers;
  }

  #onMutations(records: MutationRecord[]): void {
    if (!this.#isEventDriven()) {
      return;
    }
    for (const record of records) {
      if (record.addedNodes.length === 0) {
        continue;
      }
      // a root's first render appends to its container
      if (record.target instanceof Element) {
        this.#addReactRootOf(record.target);
      }
      record.addedNodes.forEach(node => {
        if (node instanceof Element) {
          this.#addedSinceLastFrame.push(new WeakRef(node));
        }
      });
    }
    if (
      this.#addedSinceLastFrame.length > 0 &&
      !this.#isAddedRectFrameRequested
    ) {
      this.#isAddedRectFrameRequested = true;
      requestAnimationFrame(() => this.#recordAddedRects());
    }
  }

  // Rects of added elements, read in the next frame before it is laid out
  // anyway. They are the fallback for removals past the rect budget.
  #recordAddedRects(): void {
    this.#isAddedRectFrameRequested = false;
    const queue = this.#addedSinceLastFrame;
    this.#addedSinceLastFrame = [];
    const elements: Element[] = [];
    // what is past this frame's limit, including the rest of a subtree
    const next: Array<WeakRef<Node>> = [];
    let index = 0;
    for (; index < queue.length; ++index) {
      if (elements.length >= ADDED_RECTS_PER_FRAME) {
        break;
      }
      const node = queue[index].deref();
      if (node?.isConnected) {
        for (const rest of collectElements(
          [node],
          elements,
          ADDED_RECTS_PER_FRAME,
        )) {
          next.push(new WeakRef(rest));
        }
      }
    }
    for (const element of elements) {
      if (!this.#elementToBoundingRects.has(element)) {
        const rect = utils.getBoundingClientRect(element);
        if (rect != null) {
          this.#elementToBoundingRects.set(element, rect);
        }
      }
    }
    for (; index < queue.length; ++index) {
      next.push(queue[index]);
    }
    this.#addedSinceLastFrame = next;
    if (
      this.#addedSinceLastFrame.length > 0 &&
      !this.#isAddedRectFrameRequested
    ) {
      this.#isAddedRectFrameRequested = true;
      requestAnimationFrame(() => this.#recordAddedRects());
    }
  }

  #takeRemovedElements(): Array<WeakRef<Element>> {
    const removed = this.#removedSinceLastScan;
    this.#removedSinceLastScan = [];
    if (this.#domObserver != null) {
      // removals the DOM wrappers do not cover, e.g. Range.deleteContents()
      removed.push(...this.#domObserver.getDOMElements());
    }
    return removed;
  }

  // Position and component stack can only be read while the element is still
  // attached, so take them right before it is removed. The element is then
  // tracked even if no scan saw it attached.
  #recordBeforeRemoval(elements: Element[]): void {
    if (!this.#isRemovalRectResetQueued) {
      this.#isRemovalRectResetQueued = true;
      queueMicrotask(() => {
        this.#removalRectTimeMs = 0;
        this.#isRemovalRectResetQueued = false;
      });
    }
    for (const element of elements) {
      if (this.#removalRectTimeMs < REMOVAL_RECT_BUDGET_MS) {
        const start = performance.now();
        const rect = utils.getBoundingClientRect(element);
        this.#removalRectTimeMs += performance.now() - start;
        if (rect != null) {
          this.#elementToBoundingRects.set(element, rect);
        }
      }
      const fiberNode = getFiberNodeFromElement(element);
      if (fiberNode != null) {
        this.#elementToComponentStack.set(
          element,
          getReactComponentStack(fiberNode),
        );
      }
      this.#removedSinceLastScan.push(new WeakRef(element));
    }
  }

  getDetachedDOMInfo(
    options: {includeUnconfirmed?: boolean} = {},
  ): Array<DOMElementInfo> {
    const detachedDOMElements = [];
    for (const weakRef of this.#elementWeakRefs) {
      const element = weakRef.deref();
      if (element == null || element.isConnected) {
        continue;
      }
      if (!options.includeUnconfirmed && !this.#isConfirmedDetached(element)) {
        continue;
      }
      // add a unique id to that detach dom element
      const elem = element as AnyValue;
      if (elem.detachedElementId == null) {
        const elementId = ReactMemoryScan.nextElementId++;
        elem.detachedElementIdStr = `memory-id-${elementId}@`;
        elem.detachedElementId = elementId;
      }
      const componentStack = this.#elementToComponentStack.get(element) ?? [];
      detachedDOMElements.push({
        element: weakRef,
        boundingRect: this.#elementToBoundingRects.get(element),
        componentStack,
        detachedAt: this.#detachedRecords.get(element)?.detachedAt,
        gcSurvivedCount: this.#getGCSurvivedCount(element),
      });
    }
    return detachedDOMElements;
  }

  isDevMode(): boolean {
    return this.#isDevMode;
  }

  /** GC-confirmed leaked fibers of a scan, counted per component name */
  getLeakedComponents(
    result: ScanResult,
  ): Array<{component: string; count: number}> {
    const counts = new Map<string, number>();
    for (const ref of result.leakedFibers) {
      const fiber = ref.deref();
      const name = fiber != null ? getDisplayNameOfFiberNode(fiber) : null;
      if (name != null) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    return [...counts]
      .map(([component, count]) => ({component, count}))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Runs a scan and returns a JSON-serializable summary of it. Detached
   * elements are those that survived the configured number of full GCs,
   * longest-surviving first, up to `maxDetachedElements` (default 100).
   */
  getReport(options: {maxDetachedElements?: number} = {}): MemLensReport {
    const result = this.scan();
    const now = Date.now();
    const detachedElements: ReportedDetachedElement[] =
      this.getDetachedDOMInfo()
        .map(info => {
          const element = info.element.deref() as AnyValue;
          const rect = info.boundingRect;
          return {
            id: element?.detachedElementIdStr ?? '',
            tagName: element?.tagName ?? '',
            componentStack: info.componentStack ?? [],
            detachedForMs:
              info.detachedAt != null ? now - info.detachedAt : null,
            gcSurvivedCount: info.gcSurvivedCount ?? 0,
            rect:
              rect != null
                ? {
                    x: rect.left + rect.scrollLeft,
                    y: rect.top + rect.scrollTop,
                    width: rect.width,
                    height: rect.height,
                  }
                : null,
          };
        })
        .sort(
          (a, b) =>
            b.gcSurvivedCount - a.gcSurvivedCount ||
            (b.detachedForMs ?? 0) - (a.detachedForMs ?? 0),
        );
    return {
      url: location.href,
      timestamp: now,
      gcCount: result.gcCount ?? 0,
      totals: {
        elements: result.totalElements,
        detachedElements: result.totalDetachedElements,
        detachedElementsSurvivingGC:
          result.totalDetachedElementsSurvivingGC ?? 0,
        leakedFibers: result.leakedFibers.length,
      },
      detachedElements: detachedElements.slice(
        0,
        options.maxDetachedElements ?? 100,
      ),
      leakedComponents: this.getLeakedComponents(result),
      eventListenerLeaks: result.eventListenerLeaks ?? [],
      globalListenerSites: (result.globalListenerSites ?? []).sort(
        (a, b) => b.growth - a.growth || b.count - a.count,
      ),
    };
  }

  #updateElementToComponentInfo(elements: Array<WeakRef<Element>>): void {
    for (const elemRef of elements) {
      const element = elemRef.deref();
      if (element == null || this.#elementToComponentStack.has(element)) {
        continue;
      }
      const fiberNode = getFiberNodeFromElement(element);
      if (fiberNode == null) {
        continue;
      }
      this.#elementToComponentStack.set(
        element,
        getReactComponentStack(fiberNode),
      );
    }
  }

  getCachedComponentName(elementRef: WeakRef<Element>): string {
    const FALLBACK_NAME = '<Unknown>';
    const element = elementRef.deref();
    if (element == null) {
      return FALLBACK_NAME;
    }
    const componentStack = this.#elementToComponentStack.get(element);
    if (componentStack == null) {
      return FALLBACK_NAME;
    }
    return componentStack[0] ?? FALLBACK_NAME;
  }

  updateFiberNodes(fiberNodes: Array<WeakRef<Fiber>>): Array<WeakRef<Fiber>> {
    const fibersInTree = new WeakSet<Fiber>();
    const currentFibers: Array<WeakRef<Fiber>> = [];
    for (const fiberRef of fiberNodes) {
      const fiber = fiberRef.deref();
      if (fiber != null) {
        fibersInTree.add(fiber);
        currentFibers.push(fiberRef);
      }
    }
    // React keeps two fibers per mounted component (current and alternate)
    // and swaps them on every commit, so either one being in the tree means
    // the component is still mounted.
    const isInTree = (fiber: Fiber): boolean =>
      fibersInTree.has(fiber) ||
      (fiber.alternate != null && fibersInTree.has(fiber.alternate));
    const leakedFibers: Array<WeakRef<Fiber>> = [];
    for (const fiberRef of this.#knownFiberNodes) {
      const fiber = fiberRef.deref();
      if (fiber != null && !isInTree(fiber)) {
        leakedFibers.push(fiberRef);
      }
    }
    this.#knownFiberNodes = currentFibers;
    this.#log('known fibers: ', this.#knownFiberNodes.length);
    return this.#updateUnmountedFibers(leakedFibers);
  }

  // Fibers that left the tree are kept (weakly) and reported once they have
  // survived `leakedFiberMinGCCount` full GCs; collected ones are dropped.
  #updateUnmountedFibers(
    newlyUnmounted: Array<WeakRef<Fiber>>,
  ): Array<WeakRef<Fiber>> {
    const gcCount = this.#gcTracker.getCount();
    for (const fiber of newlyUnmounted) {
      this.#unmountedFibers.push({fiber, gcCountAtUnmount: gcCount});
    }
    this.#unmountedFibers = this.#unmountedFibers.filter(
      record => record.fiber.deref() != null,
    );
    const leakedFibers = this.#unmountedFibers
      .filter(
        record =>
          gcCount - record.gcCountAtUnmount >= this.#leakedFiberMinGCCount,
      )
      .map(record => record.fiber);
    this.#log('leaked fibers: ', leakedFibers.length);
    return leakedFibers;
  }

  packLeakedFibers(leakedFibers: Array<WeakRef<Fiber>>): Array<LeakedFiber> {
    const ret = [];
    for (const leakedFiber of leakedFibers) {
      ret.push(new LeakedFiber(leakedFiber));
    }
    return ret;
  }

  #getTrackedDOMRefs(): Array<WeakRef<Element>> {
    const removed = this.#removedSinceLastScan;
    this.#removedSinceLastScan = [];
    if (this.#domObserver == null) {
      return [...utils.getDOMElements(), ...removed];
    }
    return [
      ...utils.getDOMElements(),
      ...this.#domObserver.getDOMElements(),
      ...removed,
    ];
  }

  #runGC(): void {
    if ((window as AnyValue)?.gc != null) {
      (window as AnyValue).gc();
    }
  }

  #scanEventListenerLeaks(): EventListenerLeak[] {
    if (this.#eventListenerTracker == null) {
      return [];
    }
    // Scan for event listener leaks
    const detachedListeners = this.#eventListenerTracker.scan(
      this.getCachedComponentName.bind(this),
    );
    const eventListenerLeaks: EventListenerLeak[] = [];
    for (const [componentName, groups] of detachedListeners.entries()) {
      for (const group of groups) {
        eventListenerLeaks.push({
          type: group.type,
          componentName,
          count: group.count,
        });
      }
    }
    return eventListenerLeaks;
  }

  #scanGlobalListenerSites(): GlobalListenerGrowth[] {
    if (this.#eventListenerTracker == null) {
      return [];
    }
    return this.#eventListenerTracker.getGlobalListenerSites().map(site => {
      const key = `${site.target}\u0000${site.type}\u0000${site.site}`;
      const baseline = this.#globalListenerBaseline.get(key);
      if (baseline == null) {
        this.#globalListenerBaseline.set(key, site.count);
      }
      return {...site, growth: site.count - (baseline ?? site.count)};
    });
  }

  scan(): ScanResult {
    const start = Date.now();
    this.#runGC();
    const isEventDriven = this.#isEventDriven();
    if (isEventDriven) {
      const removed = this.#takeRemovedElements();
      this.#updateElementToComponentInfo(removed);
      utils.updateWeakRefList(this.#elementWeakRefs, removed);
    } else {
      const allElements = this.#getTrackedDOMRefs();
      this.#updateElementToComponentInfo(allElements);
      this.recordBoundingRectangles(allElements);
      utils.updateWeakRefList(this.#elementWeakRefs, allElements);
    }
    const confirmedDetached = this.#updateDetachedRecords();
    if (isEventDriven) {
      // an element put back into the DOM is reported again if removed again
      this.#elementWeakRefs = this.#elementWeakRefs.filter(ref => {
        const element = ref.deref();
        return element != null && !element.isConnected;
      });
    }
    const scanResult = this.#fiberAnalyzer.scan(
      this.#elementWeakRefs,
      this.#elementToComponentStack,
      isEventDriven ? this.#getRootFibers() : [],
    );
    if (isEventDriven) {
      scanResult.totalElements =
        utils.getDOMElementCount() + scanResult.totalDetachedElements;
    }
    const leakedFibers = this.updateFiberNodes(scanResult.fiberNodes);
    scanResult.leakedFibers = leakedFibers;

    // scan for event listener leaks
    // TODO: show the results in the UI widget
    scanResult.eventListenerLeaks = this.#scanEventListenerLeaks();
    scanResult.globalListenerSites = this.#scanGlobalListenerSites();
    scanResult.gcCount = this.#gcTracker.getCount();
    scanResult.totalDetachedElementsSurvivingGC = confirmedDetached;

    (window as AnyValue).leakedFibers = this.packLeakedFibers(leakedFibers);
    const end = Date.now();
    this.#log(`scan took ${end - start}ms`);
    return scanResult;
  }
}

class LeakedFiber {
  leakedFiber: WeakRef<Fiber>;

  constructor(fiber: WeakRef<Fiber>) {
    this.leakedFiber = fiber;
  }
}
