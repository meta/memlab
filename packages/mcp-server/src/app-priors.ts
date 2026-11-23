/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * Whether heuristics written for one app family's naming conventions are on.
 *
 * `MEMLAB_NO_APP_PRIORS=1` turns them off, leaving only rules that hold for any
 * V8 heap. It exists to measure them: an A/B with and without the flag shows
 * whether a gain comes from generic analysis or from knowing the app.
 */
export function appPriorsEnabled(): boolean {
  return process.env.MEMLAB_NO_APP_PRIORS !== '1';
}

/** One line for tool output, or null when the priors are on. */
export function appPriorsNote(): string | null {
  return appPriorsEnabled()
    ? null
    : '_App priors are OFF (`MEMLAB_NO_APP_PRIORS=1`): only app-independent heuristics run. Do not rely on app-family references either._';
}
