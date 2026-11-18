/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapSnapshot} from '@memlab/core';
import {minifiedSignal} from './minified.js';
import {moduleRecords} from './module-registry.js';

/**
 * On a minified build a retainer path from the root reads
 * `requireDynamic → Be.context → system / Context / scope @387383.o →
 * Object.InteractionTracingMetrics → Object.defaultExport → …`: the module
 * system's registry, every hop of it mangled. Everything up to the module's
 * exports object says only "module X holds this", so it is printed as
 * `module:X` and the path continues from the export the module holds it by.
 */
export interface ModuleHead {
  /** Index, in the root-first path, of the module's exports object. */
  index: number;
  module: string;
}

const exportsCache = new WeakMap<IHeapSnapshot, Map<number, string>>();

function exportsOwners(snapshot: IHeapSnapshot): Map<number, string> {
  let owners = exportsCache.get(snapshot);
  if (owners == null) {
    owners = new Map();
    for (const rec of moduleRecords(snapshot).values()) {
      if (rec.exports != null) owners.set(rec.exports.id, rec.name);
      if (rec.defaultExport != null) owners.set(rec.defaultExport.id, rec.name);
    }
    exportsCache.set(snapshot, owners);
  }
  return owners;
}

/**
 * The LAST module exports object on a root-first path of node ids: the
 * module nearest the retained object. Null on a build that is not minified
 * (its paths already name modules) or when no module is on the path.
 */
export function moduleHeadOf(
  snapshot: IHeapSnapshot,
  ids: readonly (number | undefined)[],
): ModuleHead | null {
  if (!minifiedSignal(snapshot).minified) return null;
  const owners = exportsOwners(snapshot);
  for (let i = ids.length - 2; i >= 0; i--) {
    const id = ids[i];
    const module = id != null ? owners.get(id) : undefined;
    if (module != null) return {index: i, module};
  }
  return null;
}

export const RAW_PATH_DESCRIPTION =
  'Print the raw shortest path. By default, on a minified build, the hops from the root down to the module that holds the object (the module system registry, every name mangled) are replaced by `module:<Name>`, and the path continues from the export the module holds it by.';
