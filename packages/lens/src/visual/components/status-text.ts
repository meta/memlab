/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import {AnyValue} from '../../core/types';
import {
  RegisterDataUpdateCallback,
  VisualizerData,
} from '../dom-element-visualizer-interactive';
import {createVisualizerElement} from '../visual-utils';

// built at runtime so that no build step turns it into a non-ASCII
// character; the bundle may run on pages that do not declare UTF-8
const APPROX = String.fromCharCode(0x2248);

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function createStatusText(
  registerDataUpdateCallback: RegisterDataUpdateCallback,
): HTMLDivElement {
  const statusWidget = createVisualizerElement('div') as HTMLDivElement;
  statusWidget.style.marginLeft = '10px';
  statusWidget.style.color = 'white';
  statusWidget.style.fontSize = '10px';
  statusWidget.style.fontFamily = 'Inter, system-ui, sans-serif';
  statusWidget.style.overflow = 'hidden';
  statusWidget.style.whiteSpace = 'nowrap';
  statusWidget.style.textOverflow = 'ellipsis';
  statusWidget.textContent = '';

  registerDataUpdateCallback((data: VisualizerData) => {
    const totalElements = data.totalDOMElementsCount ?? 0;
    const detachedElements = data.detachedDOMElementsCount ?? 0;
    let text = `DOM: ${totalElements} total, ${detachedElements} detached`;

    // Chrome-only, and rounded and refreshed rarely unless Chrome runs with
    // --enable-precise-memory-info, so it is shown as an approximation
    const memory = (window as AnyValue).performance?.memory;
    const usedHeap = memory?.usedJSHeapSize ?? 0;
    if (usedHeap > 0) {
      const totalHeap = memory?.totalJSHeapSize ?? 0;
      text += ` | Heap ${APPROX} ${formatBytes(usedHeap)} / ${formatBytes(totalHeap)}`;
    }
    statusWidget.textContent = text;
  });

  return statusWidget;
}
