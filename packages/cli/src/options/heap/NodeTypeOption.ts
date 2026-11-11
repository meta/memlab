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

/** `--node-type <type>`: limit a heap query to one heap node type. */
export default class NodeTypeOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.NODE_TYPE;
  }

  getDescription(): string {
    return (
      'only include heap objects of this node type, ' +
      'e.g. object, closure, array, string, native'
    );
  }

  getExampleValues(): string[] {
    return ['object', 'closure', 'native'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    NodeTypeOption.getValue(args);
  }

  /** The `--node-type` value, or null when not given. */
  static getValue(args: ParsedArgs): string | null {
    const name = optionConstants.optionNames.NODE_TYPE;
    const value = args[name];
    if (value == null) {
      return null;
    }
    if (typeof value !== 'string' || value === '') {
      utils.haltOrThrow(`--${name} needs a node type`);
    }
    return `${value}`;
  }
}
