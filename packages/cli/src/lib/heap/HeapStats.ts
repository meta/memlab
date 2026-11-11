/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapEdge, IHeapNode, IHeapSnapshot} from '@memlab/core';

/**
 * The statistics split heap profilers show next to a capture (native memory
 * vs the V8 heap, and within the V8 heap code, strings, JS arrays and
 * engine-internal objects), plus a split by why the memory exists.
 * All sizes are self sizes, so every split adds up to its total.
 */
export type HeapStats = {
  /** Self size of every node plus `extraNativeBytes`. */
  total: number;
  /** Native memory the snapshot accounts for but attributes to no node. */
  extraNativeBytes: number;
  native: {total: number; typedArrays: number};
  v8Heap: {
    total: number;
    code: number;
    strings: number;
    jsArrays: number;
    system: number;
    other: number;
  };
  /** The nodes' self size (no `extraNativeBytes`), split by why it exists. */
  composition: {
    /** Source text of loaded scripts. */
    scriptSource: number;
    /** Compiled code, bytecode and function metadata. */
    compiledCode: number;
    /** Everything else: what the program allocated while it ran. */
    other: number;
  };
};

const STRING_TYPES = new Set([
  'string',
  'concatenated string',
  'sliced string',
]);

// V8 structures that hold loaded code. They exist because a script was
// loaded, not because it allocated anything.
const LOADED_CODE_NAME =
  /InstructionStream|BytecodeArray|SharedFunctionInfo|ScopeInfo|UncompiledData|FeedbackVector|FeedbackMetadata|FeedbackCell|ClosureFeedbackCellArray|\(constant pool\)|ConstantPool/;

const EXTERNAL_STRING_DATA = 'system / ExternalStringData';

/** `extra_native_bytes` from the snapshot header, or 0 when absent. */
export function getExtraNativeBytes(snapshot: IHeapSnapshot): number {
  const raw = (
    snapshot as unknown as {
      snapshot?: {snapshot?: {extra_native_bytes?: number}};
    }
  ).snapshot;
  const n = raw?.snapshot?.extra_native_bytes;
  return typeof n === 'number' && n > 0 ? n : 0;
}

/**
 * Node indexes of the strings holding the source text of loaded scripts,
 * and of the external string data behind them. Only a script's `source` is
 * counted: an app can keep its own data in external strings too.
 */
export function getScriptSourceNodes(snapshot: IHeapSnapshot): Set<number> {
  const out = new Set<number>();
  snapshot.nodes.forEach((node: IHeapNode) => {
    // V8 reports a Script either as `system / Script` or, in newer
    // versions, as a `code` node named after the script's URL
    if (node.type !== 'code' && !node.name.startsWith('system / Script')) {
      return;
    }
    for (const edge of node.references) {
      if (edge.type !== 'internal' || edge.name_or_index !== 'source') {
        continue;
      }
      const source = edge.toNode;
      if (STRING_TYPES.has(source.type)) {
        out.add(source.nodeIndex);
      }
      for (const inner of source.references) {
        if (inner.toNode.name === EXTERNAL_STRING_DATA) {
          out.add(inner.toNode.nodeIndex);
        }
      }
    }
  });
  return out;
}

/**
 * A JS array counts its elements store too when it is the store's only
 * holder; a shared store stays with `other`.
 */
function jsArraySize(node: IHeapNode): number {
  let size = node.self_size;
  const elements = node.findAnyReference(
    (e: IHeapEdge) => e.type === 'internal' && e.name_or_index === 'elements',
  )?.toNode;
  if (elements != null) {
    let holders = 0;
    elements.forEachReferrer(() => {
      holders++;
      return holders > 1 ? {stop: true} : undefined;
    });
    if (holders === 1) {
      size += elements.self_size;
    }
  }
  return size;
}

export function computeHeapStats(snapshot: IHeapSnapshot): HeapStats {
  const extraNativeBytes = getExtraNativeBytes(snapshot);
  const scriptSourceNodes = getScriptSourceNodes(snapshot);
  let selfTotal = 0;
  let native = extraNativeBytes;
  let typedArrays = 0;
  let code = 0;
  let strings = 0;
  let jsArrays = 0;
  let system = 0;
  let scriptSource = 0;
  let compiledCode = 0;
  snapshot.nodes.forEach((node: IHeapNode) => {
    const size = node.self_size;
    const type = node.type;
    selfTotal += size;

    if (type === 'hidden') {
      system += size;
    } else if (type === 'native') {
      native += size;
      if (node.name === 'system / JSArrayBufferData') {
        typedArrays += size;
      }
    } else if (type === 'code') {
      code += size;
    } else if (STRING_TYPES.has(type)) {
      strings += size;
    } else if (type === 'object' && node.name === 'Array') {
      jsArrays += jsArraySize(node);
    }

    if (scriptSourceNodes.has(node.nodeIndex)) {
      scriptSource += size;
    } else if (type === 'code' || LOADED_CODE_NAME.test(node.name)) {
      compiledCode += size;
    }
  });
  const total = selfTotal + extraNativeBytes;
  const v8Total = Math.max(0, total - native);
  return {
    total,
    extraNativeBytes,
    native: {total: native, typedArrays},
    v8Heap: {
      total: v8Total,
      code,
      strings,
      jsArrays,
      system,
      other: Math.max(0, v8Total - code - strings - jsArrays - system),
    },
    composition: {
      scriptSource,
      compiledCode,
      other: selfTotal - scriptSource - compiledCode,
    },
  };
}
