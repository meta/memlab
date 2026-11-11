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
import {BaseOption, MemLabConfig, OutputFormat, utils} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';

/**
 * `--output text|json` for the heap report commands. Same flag and values as
 * `memlab analyze <plugin> --output json`.
 */
export default class OutputFormatOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.OUTPUT_FORMAT;
  }

  getDescription(): string {
    return "output format of the report: 'text' (default) or 'json'";
  }

  getExampleValues(): string[] {
    return ['text', 'json'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    const value = args[this.getOptionName()];
    if (value == null) {
      return;
    }
    switch (`${value}`.toLowerCase()) {
      case 'text':
        config.outputFormat = OutputFormat.Text;
        return;
      case 'json':
        config.outputFormat = OutputFormat.Json;
        // keeps progress messages out of stdout, as `memlab analyze` does
        config.isContinuousTest = true;
        return;
      default:
        utils.haltOrThrow(
          `Invalid --${this.getOptionName()} value: ${value} (expected 'text' or 'json')`,
        );
    }
  }
}
