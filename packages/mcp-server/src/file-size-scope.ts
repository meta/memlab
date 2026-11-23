/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {AsyncLocalStorage} from 'node:async_hooks';

/**
 * The `max_file_size_mb` of the tool call in progress.
 *
 * The guardrail sets it from the call's arguments, so a loader deep inside a
 * tool honors the caller's limit without every tool threading it through.
 */
const scope = new AsyncLocalStorage<number>();

export function withFileSizeLimit<T>(mb: number | undefined, fn: () => T): T {
  return mb != null && Number.isFinite(mb) && mb > 0 ? scope.run(mb, fn) : fn();
}

export function callFileSizeLimit(): number | undefined {
  return scope.getStore();
}

/** `MEMLAB_MAX_FILE_SIZE_MB`, when set to a positive number. */
export function envFileSizeLimit(): number | undefined {
  const mb = Number(process.env.MEMLAB_MAX_FILE_SIZE_MB);
  return Number.isFinite(mb) && mb > 0 ? mb : undefined;
}
