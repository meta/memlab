/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

// the same interaction on the version of the example app without the leak
const leak = require('./leak');

function url() {
  return `${process.env.MEMLAB_EXAMPLE_URL}?fixed`;
}

module.exports = {...leak, url};
