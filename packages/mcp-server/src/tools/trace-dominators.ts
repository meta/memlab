/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode} from '@memlab/core';
import {z} from 'zod';
import {sizeInput, withSizeHint} from '../byte-size.js';
import {heaviestChildIndex, topDominatedChildren} from '../dominator-index.js';
import {getSnapshot} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  truncateNodeName,
  errorResult,
  toolResult,
} from '../utils.js';

interface DominatorStep {
  nodeId: number;
  name: string;
  type: string;
  selfSize: number;
  retainedSize: number;
  edgeName: string | null;
  childCount: number;
  promiseState?: 'pending' | 'resolved';
  elementCount?: number;
}

function detectPromiseState(
  node: IHeapNode,
): 'pending' | 'resolved' | undefined {
  if (node.name !== 'Promise') return undefined;
  for (const edge of node.references) {
    if (
      edge.type === 'internal' &&
      String(edge.name_or_index) === 'reactions_or_result'
    ) {
      return edge.toNode.name === 'PromiseReaction' ? 'pending' : 'resolved';
    }
  }
  return undefined;
}

function getArrayElementCount(node: IHeapNode): number | undefined {
  if (node.name !== 'Array' || node.type !== 'object') return undefined;
  for (const edge of node.references) {
    if (edge.type === 'internal' && String(edge.name_or_index) === 'elements') {
      return edge.toNode.edge_count;
    }
  }
  return undefined;
}

function findEdgeName(parent: IHeapNode, childId: number): string | null {
  if (parent.edge_count > 10000) return null;
  for (const edge of parent.references) {
    if (edge.toNode.id === childId) {
      return String(edge.name_or_index);
    }
  }
  return null;
}

export function registerTraceDominators(server: McpServer): void {
  server.tool(
    'memlab_trace_dominators',
    'Auto-walk the dominator tree from a starting node, following the largest dominated child at each level until reaching leaf data or a depth limit. Returns the full chain with size annotations in a single call — eliminates the 10+ sequential get_references calls typically needed to trace from a top retainer to the actual data. Collapses repetitive Promise/PromiseReaction chains. Shows top children at the terminal node. Use as the primary tool after identifying a large retainer via auto_investigate or largest_objects.',
    {
      node_id: z.number().describe('Starting node ID to trace from'),
      max_depth: z
        .number()
        .optional()
        .default(25)
        .describe('Maximum depth to trace (default 25)'),
      min_retained_size: sizeInput()
        .optional()
        .describe(
          withSizeHint(
            'Stop when retained size drops below this (bytes). Useful to avoid tracing into small leaf nodes.',
          ),
        ),
      collapse_promises: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Collapse repetitive Promise/PromiseReaction chains into a summary (default true)',
        ),
      show_siblings: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'At each branch point (childCount > 1), show the top-3 children with their edge names and sizes, giving visibility into where memory fans out (default false)',
        ),
    },
    async ({
      node_id,
      max_depth,
      min_retained_size,
      collapse_promises,
      show_siblings,
    }) => {
      try {
        const snapshot = getSnapshot();
        const startNode = snapshot.getNodeById(node_id);
        if (!startNode) {
          return errorResult(`Node with id ${node_id} not found`);
        }

        const {heaviest, children} = heaviestChildIndex(snapshot);
        const largestChild = (node: IHeapNode): IHeapNode | null =>
          heaviest[node.nodeIndex] >= 0
            ? snapshot.nodes.get(heaviest[node.nodeIndex])
            : null;

        // Walk the dominator chain
        const rawSteps: DominatorStep[] = [];
        let current: IHeapNode = startNode;
        const visited = new Set<number>();

        while (rawSteps.length < max_depth) {
          if (visited.has(current.id)) break;
          visited.add(current.id);

          let edgeName: string | null = null;
          if (rawSteps.length > 0) {
            const prevNode = snapshot.getNodeById(
              rawSteps[rawSteps.length - 1].nodeId,
            );
            if (prevNode) {
              edgeName = findEdgeName(prevNode, current.id);
            }
          }

          rawSteps.push({
            nodeId: current.id,
            name: current.name,
            type: current.type,
            selfSize: current.self_size,
            retainedSize: current.retainedSize,
            edgeName,
            childCount: children[current.nodeIndex],
            promiseState: detectPromiseState(current),
            elementCount: getArrayElementCount(current),
          });

          const next = largestChild(current);
          if (!next) break;
          if (
            min_retained_size != null &&
            next.retainedSize < min_retained_size
          ) {
            break;
          }
          current = next;
        }

        const topChildren = topDominatedChildren(
          snapshot,
          rawSteps.map(st => st.nodeId),
          5,
        );

        // Collapse Promise chains
        interface OutputStep extends DominatorStep {
          collapsedPromiseHops?: number;
        }
        let steps: OutputStep[];

        if (collapse_promises) {
          steps = [];
          let i = 0;
          while (i < rawSteps.length) {
            const step = rawSteps[i];
            if (
              (step.name === 'Promise' || step.name === 'PromiseReaction') &&
              i + 1 < rawSteps.length
            ) {
              const runStart = i;
              while (
                i < rawSteps.length &&
                (rawSteps[i].name === 'Promise' ||
                  rawSteps[i].name === 'PromiseReaction')
              ) {
                i++;
              }
              const hops = i - runStart;
              if (hops >= 3) {
                const first = rawSteps[runStart];
                steps.push({
                  ...first,
                  name: 'Promise chain',
                  collapsedPromiseHops: hops,
                  promiseState: first.promiseState,
                });
              } else {
                for (let j = runStart; j < i; j++) {
                  steps.push(rawSteps[j]);
                }
              }
            } else {
              steps.push(step);
              i++;
            }
          }
        } else {
          steps = rawSteps;
        }

        // Format output
        const lines: string[] = ['## Dominator Trace', ''];

        for (let i = 0; i < steps.length; i++) {
          const s = steps[i];
          const indent = '  '.repeat(i);
          const name = truncateNodeName(s.name, s.type, s.selfSize, 80);
          const arrow = i === 0 ? '' : `→ [${s.edgeName ?? '…'}] `;

          const annotations: string[] = [];
          if (s.promiseState) annotations.push(s.promiseState);
          if (s.collapsedPromiseHops)
            annotations.push(`${s.collapsedPromiseHops} hops`);
          if (s.elementCount != null)
            annotations.push(`${formatNumber(s.elementCount)} elements`);
          if (s.childCount > 1 && !s.collapsedPromiseHops)
            annotations.push(`${formatNumber(s.childCount)} children`);

          const ann =
            annotations.length > 0 ? ` — ${annotations.join(', ')}` : '';
          lines.push(
            `${indent}${arrow}@${s.nodeId} ${name} (${formatBytes(s.retainedSize)})${ann}`,
          );

          // Show top-3 sibling children at branch points
          if (show_siblings && s.childCount > 1 && !s.collapsedPromiseHops) {
            const siblings = topChildren.get(s.nodeId);
            if (siblings && siblings.length > 1) {
              const parentNode = snapshot.getNodeById(s.nodeId);
              const siblingIndent = indent + '  ';
              const nextNodeId =
                i + 1 < steps.length ? steps[i + 1].nodeId : -1;
              const otherChildren = siblings
                .filter(c => c.id !== nextNodeId)
                .slice(0, 3);
              if (otherChildren.length > 0) {
                lines.push(
                  `${siblingIndent}_(other children at this branch:)_`,
                );
                for (const child of otherChildren) {
                  const cName = truncateNodeName(
                    child.name,
                    child.type,
                    child.self_size,
                    50,
                  );
                  const cEdge = parentNode
                    ? findEdgeName(parentNode, child.id)
                    : null;
                  lines.push(
                    `${siblingIndent}  [${cEdge ?? '?'}] @${child.id} ${cName} (${formatBytes(child.retainedSize)})`,
                  );
                }
              }
            }
          }
        }

        // Show top children of the terminal node
        const terminalStep = rawSteps[rawSteps.length - 1];
        const terminalChildren = topChildren.get(terminalStep.nodeId);
        if (terminalChildren && terminalChildren.length > 1) {
          const terminalIndent = '  '.repeat(steps.length);
          lines.push('');
          lines.push(
            `${terminalIndent}**Top children of @${terminalStep.nodeId}:**`,
          );
          const terminalNode = snapshot.getNodeById(terminalStep.nodeId);
          for (const child of terminalChildren) {
            const cName = truncateNodeName(
              child.name,
              child.type,
              child.self_size,
              60,
            );
            const cEdge = terminalNode
              ? findEdgeName(terminalNode, child.id)
              : null;
            const elCount = getArrayElementCount(child);
            const elNote =
              elCount != null ? ` — ${formatNumber(elCount)} elements` : '';
            lines.push(
              `${terminalIndent}  [${cEdge ?? '?'}] @${child.id} ${cName} (${formatBytes(child.retainedSize)})${elNote}`,
            );
          }
        }

        // Stop reason
        const terminalNodeForStop = snapshot.getNodeById(terminalStep.nodeId);
        const nextChild =
          terminalNodeForStop != null
            ? largestChild(terminalNodeForStop)
            : null;
        if (!nextChild) {
          lines.push('', '_(leaf node — no dominated children)_');
        } else if (
          min_retained_size != null &&
          nextChild.retainedSize < min_retained_size
        ) {
          lines.push(
            '',
            `_(stopped: next child ${formatBytes(nextChild.retainedSize)} < threshold ${formatBytes(min_retained_size)})_`,
          );
        } else if (rawSteps.length >= max_depth) {
          lines.push('', `_(stopped at max depth ${max_depth})_`);
        }

        // Summary
        lines.push('', '---');
        lines.push(
          `**Trace:** ${rawSteps.length} nodes, @${rawSteps[0].nodeId} (${formatBytes(rawSteps[0].retainedSize)}) → @${terminalStep.nodeId} (${formatBytes(terminalStep.retainedSize)})`,
        );

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
