/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import * as React from 'react';

const ESCAPE = String.fromCharCode(27);
const COLOR_CODE = new RegExp(`${ESCAPE}\\[([0-9;]*)m`);
const COLORS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
];

// splits terminal output into runs of text that share the same color and weight
function parseColors(output) {
  const runs = [];
  let color = null;
  let bold = false;
  let dim = false;
  output.split(COLOR_CODE).forEach((part, i) => {
    if (i % 2 === 0) {
      if (part !== '') {
        runs.push({text: part, color, bold, dim});
      }
      return;
    }
    for (const code of part.split(';').map(Number)) {
      if (code === 0) {
        color = null;
        bold = false;
        dim = false;
      } else if (code === 1) {
        bold = true;
      } else if (code === 2) {
        dim = true;
      } else if (code === 22) {
        bold = false;
        dim = false;
      } else if (code === 39) {
        color = null;
      } else if (code >= 30 && code <= 37) {
        color = COLORS[code - 30];
      } else if (code >= 90 && code <= 97) {
        color = code === 90 ? 'grey' : `bright-${COLORS[code - 90]}`;
      }
    }
  });
  return runs;
}

// terminal output with its colors, as `memlab` prints it in a terminal
export default function TerminalOutput({output}) {
  return (
    <pre className="terminal-output">
      <code>
        {parseColors(output.trimEnd()).map(({bold, color, dim, text}, i) => {
          const classes = [
            color && `terminal-${color}`,
            bold && 'terminal-bold',
            dim && 'terminal-dim',
          ].filter(Boolean);
          return classes.length === 0 ? (
            text
          ) : (
            <span key={i} className={classes.join(' ')}>
              {text}
            </span>
          );
        })}
      </code>
    </pre>
  );
}
