/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import TerminalReplay from './TerminalReplay';
import * as React from 'react';
import {useCallback, useEffect, useRef, useState} from 'react';

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

// the replay needs a doc column at least this wide to stay readable
const MIN_REPLAY_WIDTH = 640;

function StaticOutput({output}) {
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

// plays a recorded terminal session, scaled down to fit the doc column, and
// shows the last key pressed in it below
function ReplayOutput({replay}) {
  const outerRef = useRef(null);
  const [scale, setScale] = useState(1);
  const [run, setRun] = useState(0);
  const [ended, setEnded] = useState(false);
  const [keyPress, setKeyPress] = useState(null);
  const onEnd = useCallback(() => setEnded(true), []);
  const onKey = useCallback((event) => setKeyPress(event), []);

  useEffect(() => {
    const outer = outerRef.current;
    const terminal = outer.querySelector('.terminal-inner');
    // the terminal's own width, measured once before it is scaled
    const width = terminal.offsetWidth;
    let columnWidth = null;
    let frame = null;
    // scaling changes the column's height, so only width changes rescale it,
    // in the next frame rather than inside the observer's callback
    const observer = new ResizeObserver(() => {
      if (outer.clientWidth === columnWidth) {
        return;
      }
      columnWidth = outer.clientWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setScale(Math.min(1, columnWidth / width)),
      );
    });
    observer.observe(outer);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="terminal-output-replay" ref={outerRef}>
      <div className="terminal-output-replay-screen" style={{zoom: scale}}>
        <TerminalReplay
          cols={replay.columns}
          introLines={0}
          key={run}
          onEnd={onEnd}
          onKey={onKey}
          rows={replay.rows}
          scrollbackOnEnd={false}
          stdouts={replay.events}
        />
        <div className="terminal-output-replay-keys">
          {keyPress != null ? (
            <span className="terminal-output-replay-key" key={keyPress.time}>
              <kbd>{keyPress.key}</kbd> {keyPress.caption}
            </span>
          ) : null}
          {ended ? (
            <button
              className="terminal-output-replay-button"
              onClick={() => {
                setEnded(false);
                setKeyPress(null);
                setRun(run + 1);
              }}
              type="button">
              Replay
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Terminal output with its colors, as `memlab` prints it in a terminal. With
// a `replay` (a recorded session: `{columns, rows, events}`), the session is
// played instead where the doc column is wide enough; the server-rendered
// page and narrow screens show `output`.
export default function TerminalOutput({output, replay}) {
  const containerRef = useRef(null);
  const [canReplay, setCanReplay] = useState(false);
  useEffect(() => {
    if (replay != null) {
      setCanReplay(containerRef.current.clientWidth >= MIN_REPLAY_WIDTH);
    }
  }, [replay]);
  return (
    <div ref={containerRef}>
      {canReplay ? (
        <ReplayOutput replay={replay} />
      ) : (
        <StaticOutput output={output} />
      )}
    </div>
  );
}
