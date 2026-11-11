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
import {BaseOption, MemLabConfig} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';

/** `--detached`: limit a heap query to detached DOM elements and fibers. */
export default class DetachedOnlyOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.DETACHED_ONLY;
  }

  getDescription(): string {
    return 'only include detached objects (DOM elements, React fibers)';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    DetachedOnlyOption.getValue(args);
  }

  static getValue(args: ParsedArgs): boolean {
    return Boolean(args[optionConstants.optionNames.DETACHED_ONLY]);
  }
}
