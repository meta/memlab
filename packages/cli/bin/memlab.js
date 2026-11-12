#!/usr/bin/env node --expose-gc --max-old-space-size=4096

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

// https://no-color.org: chalk turns colors off for FORCE_COLOR=0, so map
// NO_COLOR to it before any package loads chalk
if (process.env.NO_COLOR && process.env.FORCE_COLOR == null) {
  process.env.FORCE_COLOR = '0';
}

// eslint-disable-next-line no-var
var cli = require('../dist/index');

// register the `@memlab/cli` package info
// so that `memlab version` get use the info
// eslint-disable-next-line fb-www/promise-termination
cli.registerPackage().then(() => {
  cli.run();
});
