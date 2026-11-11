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
import {parseSize} from '../../lib/heap/FindObjects';

/** `--min-retained-size <size>`: skip objects that retain less. */
export default class MinRetainedSizeOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.MIN_RETAINED_SIZE;
  }

  getDescription(): string {
    return (
      'only include objects that retain at least this much memory, ' +
      'in bytes or with a unit (KB, MB, GB; powers of 1024)'
    );
  }

  getExampleValues(): string[] {
    return ['100000', '500KB', '1.5MB'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    MinRetainedSizeOption.getValue(args);
  }

  /** The size in bytes, or 0 when not given. */
  static getValue(args: ParsedArgs): number {
    const name = optionConstants.optionNames.MIN_RETAINED_SIZE;
    const value = args[name];
    if (value == null) {
      return 0;
    }
    const bytes = parseSize(`${value}`);
    if (bytes == null) {
      utils.haltOrThrow(
        `Invalid --${name} value: ${value} (expected bytes, or a size like 500KB or 1.5MB)`,
      );
    }
    return bytes ?? 0;
  }
}
