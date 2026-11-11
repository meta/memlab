/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {ParsedArgs} from 'minimist';
import {BaseOption, MemLabConfig, utils} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';

export const DEFAULT_TOP = 30;

/** `--top <N>`: how many rows a heap report prints. */
export default class TopOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.TOP;
  }

  getDescription(): string {
    return `number of rows to report (default ${DEFAULT_TOP})`;
  }

  getExampleValues(): string[] {
    return ['10', '100'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    TopOption.getValue(args);
  }

  /** The `--top` value, or the default when it is not given. */
  static getValue(args: ParsedArgs): number {
    const name = optionConstants.optionNames.TOP;
    const value = args[name];
    if (value == null) {
      return DEFAULT_TOP;
    }
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
      utils.haltOrThrow(
        `Invalid --${name} value: ${value} (expected a positive integer)`,
      );
    }
    return n;
  }
}
