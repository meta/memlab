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
import {parseNamePattern} from '../../lib/heap/ClassHistogram';

/** `--name-pattern <regex>`: limit a heap report to matching class names. */
export default class NamePatternOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.NAME_PATTERN;
  }

  getDescription(): string {
    return (
      'only report classes whose name matches this case-insensitive regular ' +
      'expression (or plain text)'
    );
  }

  getExampleValues(): string[] {
    return ['Detached', '^Fiber'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    NamePatternOption.getValue(args);
  }

  /** The `--name-pattern` value as a RegExp, or null when not given. */
  static getValue(args: ParsedArgs): RegExp | null {
    const name = optionConstants.optionNames.NAME_PATTERN;
    const value = args[name];
    if (value == null) {
      return null;
    }
    // a bare `--name-pattern` parses as `true`
    if (typeof value === 'boolean' || `${value}` === '') {
      utils.haltOrThrow(`--${name} needs a pattern`);
    }
    return parseNamePattern(`${value}`);
  }
}
