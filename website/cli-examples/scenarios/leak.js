/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

// opens and closes the settings dialog of the example app once
function url() {
  return process.env.MEMLAB_EXAMPLE_URL;
}

async function action(page) {
  await page.click('#open-settings');
}

async function back(page) {
  await page.click('#close-settings');
}

module.exports = {action, back, url};
