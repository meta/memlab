/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode, IHeapSnapshot} from '@memlab/core';

export type ScriptGroup = {
  /**
   * The script URL without its query string, or the start of the source
   * when the script has no URL.
   */
  key: string;
  /** Whether `key` is a URL rather than a source prefix. */
  hasUrl: boolean;
  /** Script objects in the group. */
  scripts: number;
  /** Distinct source texts the group's scripts keep alive. */
  sources: number;
  /** Bytes of source text, each distinct source counted once. */
  sourceBytes: number;
  /** Source bytes of every copy but the largest. */
  duplicateBytes: number;
};

export type ScriptCensus = {
  totalSourceBytes: number;
  totalHeapBytes: number;
  scriptCount: number;
  duplicateBytes: number;
  groups: ScriptGroup[];
};

const SCRIPT_PREFIX = 'system / Script';
const KEY_PREFIX_LENGTH = 120;

/**
 * The source string of a V8 Script object, or null when the node is not a
 * Script. V8 reports a Script as `system / Script / <url>` or, in newer
 * versions, as a `code` node named after its URL; either way it has an
 * internal `source` edge to its source string.
 */
export function getScriptSource(node: IHeapNode): IHeapNode | null {
  if (node.type !== 'code' && !node.name.startsWith(SCRIPT_PREFIX)) {
    return null;
  }
  for (const edge of node.references) {
    if (
      edge.type === 'internal' &&
      edge.name_or_index === 'source' &&
      edge.toNode.isString
    ) {
      return edge.toNode;
    }
  }
  return null;
}

/** The script's URL from its node name, or '' when it has none. */
export function getScriptUrl(node: IHeapNode): string {
  const name = node.name;
  if (name.startsWith(SCRIPT_PREFIX)) {
    return name.slice(SCRIPT_PREFIX.length).replace(/^ \/ /, '').trim();
  }
  return name.trim();
}

/**
 * Bytes of a source string: the string node, the halves of a concatenated
 * string, and the external data that holds the text of an external string
 * (a browser keeps most script source there). Nodes in `seen` are already
 * counted for another script and are skipped.
 */
function sourceBytes(source: IHeapNode, seen: Set<number>): number {
  let bytes = 0;
  const stack = [source];
  while (stack.length > 0) {
    const node = stack.pop() as IHeapNode;
    if (seen.has(node.nodeIndex)) {
      continue;
    }
    seen.add(node.nodeIndex);
    bytes += node.self_size;
    for (const edge of node.references) {
      const to = edge.toNode;
      if (to.name === 'system / ExternalStringData') {
        bytes += seen.has(to.nodeIndex) ? 0 : to.self_size;
        seen.add(to.nodeIndex);
      } else if (
        node.type === 'concatenated string' &&
        (edge.name_or_index === 'first' || edge.name_or_index === 'second')
      ) {
        stack.push(to);
      }
    }
  }
  return bytes;
}

/**
 * The group a script belongs to: its URL without the query string or
 * fragment, so a bundle fetched again with a cache-busting parameter groups
 * with the first copy.
 */
export function getScriptGroupKey(url: string): string {
  return url.replace(/[?#].*$/, '');
}

/**
 * The retained source text of every loaded script, grouped by script URL
 * (without the query string), or by the start of the source for scripts
 * without one. A group with more than
 * one distinct source is the same script kept in memory more than once, for
 * example a bundle fetched again while functions from the first copy are
 * still reachable.
 */
export function censusScripts(snapshot: IHeapSnapshot): ScriptCensus {
  let totalHeapBytes = 0;
  let scriptCount = 0;
  const seenSources = new Set<number>();
  // string nodes already counted, shared by every script
  const counted = new Set<number>();
  const groups = new Map<string, ScriptGroup & {sizes: number[]}>();
  snapshot.nodes.forEach(node => {
    totalHeapBytes += node.self_size;
    const source = getScriptSource(node);
    if (source == null) {
      return;
    }
    scriptCount++;
    const url = getScriptUrl(node);
    const prefix = source.name
      .slice(0, KEY_PREFIX_LENGTH)
      .replace(/\s+/g, ' ')
      .trim();
    const key =
      url !== '' ? getScriptGroupKey(url) : prefix || '(empty source)';
    let group = groups.get(key);
    if (group == null) {
      group = {
        key,
        hasUrl: url !== '',
        scripts: 0,
        sources: 0,
        sourceBytes: 0,
        duplicateBytes: 0,
        sizes: [],
      };
      groups.set(key, group);
    }
    group.scripts++;
    if (seenSources.has(source.nodeIndex)) {
      return;
    }
    seenSources.add(source.nodeIndex);
    const bytes = sourceBytes(source, counted);
    group.sources++;
    group.sourceBytes += bytes;
    group.sizes.push(bytes);
  });

  let totalSourceBytes = 0;
  let duplicateBytes = 0;
  const result: ScriptGroup[] = [];
  for (const {sizes, ...group} of groups.values()) {
    group.duplicateBytes = group.sourceBytes - Math.max(0, ...sizes);
    totalSourceBytes += group.sourceBytes;
    duplicateBytes += group.duplicateBytes;
    result.push(group);
  }
  result.sort(
    (a, b) =>
      b.duplicateBytes - a.duplicateBytes ||
      b.sourceBytes - a.sourceBytes ||
      a.key.localeCompare(b.key),
  );
  return {
    totalSourceBytes,
    totalHeapBytes,
    scriptCount,
    duplicateBytes,
    groups: result,
  };
}
