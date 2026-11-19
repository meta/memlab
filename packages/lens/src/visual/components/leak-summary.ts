/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import type {LeakSummary} from '../../core/types';
import {
  RegisterDataUpdateCallback,
  VisualizerData,
} from '../dom-element-visualizer-interactive';
import {createVisualizerElement} from '../visual-utils';

const MAX_LISTED_COMPONENTS = 3;
// built at runtime so that no build step turns them back into non-ASCII
// characters; the bundle may run on pages that do not declare UTF-8
const TIMES = String.fromCharCode(0xd7);
const DOT = String.fromCharCode(0xb7);

export function formatLeakSummary(summary: LeakSummary): string {
  const components = summary.leakedComponents;
  let react = 'no leaked components';
  if (components.length > 0) {
    react = components
      .slice(0, MAX_LISTED_COMPONENTS)
      .map(({component, count}) => `${component} ${TIMES}${count}`)
      .join(', ');
    if (components.length > MAX_LISTED_COMPONENTS) {
      react += `, +${components.length - MAX_LISTED_COMPONENTS} more`;
    }
  }
  const sites = summary.growingGlobalListenerSites;
  return (
    `React: ${react} ${DOT} ` +
    `Listeners: ${summary.listenersOnDetachedElements} on detached elements, ` +
    `${sites} growing ${sites === 1 ? 'site' : 'sites'} on window/document ${DOT} ` +
    `GCs: ${summary.gcCount}`
  );
}

/**
 * A row under the widget header with what the last scan found beyond
 * detached elements, and a button that copies the full JSON report.
 */
export function createLeakSummary(
  registerDataUpdateCallback: RegisterDataUpdateCallback,
  getReport?: () => object,
): HTMLDivElement {
  const row = createVisualizerElement('div') as HTMLDivElement;
  row.id = 'memory-visualization-leak-summary';
  row.style.display = 'flex';
  row.style.alignItems = 'center';
  row.style.gap = '8px';
  row.style.padding = '0 8px 8px 8px';
  row.style.color = 'rgba(255, 255, 255, 0.85)';
  row.style.fontSize = '10px';
  row.style.fontFamily = 'Inter, system-ui, sans-serif';

  const text = createVisualizerElement('div');
  text.style.flex = '1';
  text.style.lineHeight = '14px';
  row.appendChild(text);

  if (getReport != null) {
    const button = createVisualizerElement('button') as HTMLButtonElement;
    button.type = 'button';
    button.textContent = 'Copy report';
    button.style.font = 'inherit';
    button.style.color = 'white';
    button.style.background = 'rgba(255, 255, 255, 0.15)';
    button.style.border = 'none';
    button.style.borderRadius = '4px';
    button.style.padding = '3px 8px';
    button.style.cursor = 'pointer';
    button.style.whiteSpace = 'nowrap';
    button.addEventListener('click', () => {
      const json = JSON.stringify(getReport(), null, 2);
      const done = (label: string) => {
        button.textContent = label;
        setTimeout(() => (button.textContent = 'Copy report'), 1500);
      };
      // also logged, for pages where the clipboard is not available
      console.log('[MemLens] report', JSON.parse(json));
      navigator.clipboard?.writeText(json).then(
        () => done('Copied'),
        () => done('Logged to console'),
      ) ?? done('Logged to console');
    });
    row.appendChild(button);
  }

  registerDataUpdateCallback((data: VisualizerData) => {
    text.textContent =
      data.summary != null ? formatLeakSummary(data.summary) : '';
  });
  return row;
}
