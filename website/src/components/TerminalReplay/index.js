/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import _ from './css/styles.css';
import Terminal from './lib/Term';
import createTimeline from './lib/TimelineFactory';
import * as React from 'react';
import {useEffect, useRef, useState} from 'react';

// lines printed before the demo waits for the terminal to scroll into view
const INTRO_LINES = 2;
const REVEAL_RATIO = 0.3;

function initializeTerminal(id, cols, rows) {
  const terminal = new Terminal({
    cols,
    rows,
    screenKeys: true,
  });

  terminal.open(document.querySelector(`#${id} .content`));
  return terminal;
}

function getIntroEndTime(stdouts, introLines) {
  if (introLines === 0) {
    return -1;
  }
  let lines = 0;
  for (const {content = '', time} of stdouts) {
    lines += content.split('\r\n').length - 1;
    if (lines >= introLines) {
      return time;
    }
  }
  return Infinity;
}

// the terminal only renders its last `rows` lines; once the replay ends,
// render the scrollback above them so the whole output can be scrolled
function renderScrollback(terminal) {
  const firstRow = terminal.children[0];
  const fragment = document.createDocumentFragment();
  for (let row = 0; row < terminal.ybase; row++) {
    terminal.ydisp = row;
    terminal.refresh(0, 0);
    const line = document.createElement('div');
    line.innerHTML = firstRow.innerHTML;
    fragment.appendChild(line);
  }
  terminal.ydisp = terminal.ybase;
  terminal.refresh(0, 0);
  terminal.element.insertBefore(fragment, firstRow);
}

let gid = 0;

// Replays `stdouts` (`[{time, content}]`, raw terminal output with the time
// it was printed) in a `cols` x `rows` terminal. The first `introLines` lines
// play right away; the rest plays once the terminal scrolls into view. With
// `scrollbackOnEnd`, the whole output becomes scrollable when the replay ends.
// `onEnd` is called when the replay ends, and `onKey` with each key press
// event (`{time, key, caption}`) as it plays; a new callback restarts the
// replay.
const TerminalDemo = ({
  stdouts,
  cols = 90,
  rows = 28,
  introLines = INTRO_LINES,
  scrollbackOnEnd = true,
  onEnd,
  onKey,
}) => {
  const [id] = useState(`terminal-${gid++}`);
  const innerRef = useRef(null);
  useEffect(() => {
    const inner = innerRef.current;
    const terminal = initializeTerminal(id, cols, rows);
    const timeline = createTimeline(terminal, stdouts, onKey);
    const introEndTime = getIntroEndTime(stdouts, introLines);
    let revealed = false;
    let inView = false;
    let ended = false;

    const sync = () => {
      const inIntro = timeline.position() <= introEndTime;
      if (!ended && (inIntro || (revealed && inView))) {
        timeline.play();
      } else {
        timeline.pause();
      }
    };

    timeline.on('tick', sync);
    timeline.on('end', () => {
      ended = true;
      if (scrollbackOnEnd) {
        inner.style.height = `${inner.offsetHeight}px`;
        renderScrollback(terminal);
        inner.classList.add('terminal-scrollable');
        inner.scrollTop = inner.scrollHeight;
      }
      onEnd?.();
    });

    const observer = new IntersectionObserver(
      ([entry]) => {
        inView = entry.intersectionRatio > 0;
        if (entry.intersectionRatio >= REVEAL_RATIO) {
          revealed = true;
        }
        sync();
      },
      {threshold: [0, REVEAL_RATIO]},
    );
    observer.observe(inner);
    sync();

    return () => {
      observer.disconnect();
      timeline.pause();
      clearInterval(terminal._blink);
      terminal.element.remove();
    };
  }, [id, stdouts, cols, rows, introLines, scrollbackOnEnd, onEnd, onKey]);

  return (
    <div className="terminal-content">
      <div id={id} className="terminal-inner" ref={innerRef}>
        <div xterm={true} className="content" />
      </div>
    </div>
  );
};

export default TerminalDemo;
