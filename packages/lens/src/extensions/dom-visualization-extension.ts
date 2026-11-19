/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import type ReactMemoryScan from '../core/react-memory-scan';
import type {AnalysisResult, LeakSummary, Nullable} from '../core/types';

import DOMElementVisualizer from '../visual/dom-element-visualizer';
import DOMElementVisualizerInteractive from '../visual/dom-element-visualizer-interactive';
import {BasicExtension} from './basic-extension';

const USE_INTERACTIVE_VISUALIZER = true;

function summarize(
  result: AnalysisResult,
  leakedComponents: LeakSummary['leakedComponents'],
): LeakSummary {
  const detachedSurvivingGC = result.totalDetachedElementsSurvivingGC ?? 0;
  return {
    gcCount: result.gcCount ?? 0,
    detachedSurvivingGC,
    detachedWaitingForGC: Math.max(
      0,
      result.totalDetachedElements - detachedSurvivingGC,
    ),
    leakedComponents,
    listenersOnDetachedElements: (result.eventListenerLeaks ?? []).reduce(
      (sum, leak) => sum + leak.count,
      0,
    ),
    growingGlobalListenerSites: (result.globalListenerSites ?? []).filter(
      site => site.growth > 0,
    ).length,
  };
}

export class DOMVisualizationExtension extends BasicExtension {
  #domVirtualizer: Nullable<DOMElementVisualizer>;

  constructor(scanner: ReactMemoryScan) {
    super(scanner);
    if (USE_INTERACTIVE_VISUALIZER) {
      this.#domVirtualizer = new DOMElementVisualizerInteractive({
        getReport: () => scanner.getReport(),
      });
    } else {
      this.#domVirtualizer = new DOMElementVisualizer();
    }
  }

  afterScan(analysisResult: AnalysisResult): void {
    const scanner = this.scanner;
    if (scanner.isDevMode()) {
      const detachedDOMInfo = scanner.getDetachedDOMInfo();
      this.#domVirtualizer?.repaint(
        detachedDOMInfo,
        summarize(analysisResult, scanner.getLeakedComponents(analysisResult)),
      );
    }
  }

  cleanup(): void {
    // Clean up the visualizer to prevent memory leaks
    if (
      this.#domVirtualizer &&
      typeof this.#domVirtualizer.cleanup === 'function'
    ) {
      this.#domVirtualizer.cleanup();
    }
    // Clear the reference
    this.#domVirtualizer = null;
  }
}
