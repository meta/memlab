/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

// opens and closes the settings dialog four times, for snapshot series
const leak = require('./leak');

function repeat() {
  return 3;
}

module.exports = {...leak, repeat};
