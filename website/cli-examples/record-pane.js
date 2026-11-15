/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

// Records what a tmux pane prints, with the time of each write, for the
// terminal replays on the CLI doc pages. `capture.js` starts it with
// `tmux pipe-pane`, which sends the pane's output to stdin, and stops it by
// closing the pipe; the recording is then written to the file in argv[2] as
// JSON: `[{time, content}]`, with `time` in milliseconds since the start.

'use strict';

const fs = require('fs');
const {StringDecoder} = require('string_decoder');

const file = process.argv[2];
const start = Date.now();
const decoder = new StringDecoder('utf8');
const events = [];

process.stdin.on('data', (chunk) => {
  const content = decoder.write(chunk);
  if (content !== '') {
    events.push({time: Date.now() - start, content});
  }
});

process.stdin.on('end', () => {
  const rest = decoder.end();
  if (rest !== '') {
    events.push({time: Date.now() - start, content: rest});
  }
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(events));
  fs.renameSync(`${file}.tmp`, file);
});
