/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import Timeline from './Timeline';

// `stdouts` are `{time, content}` writes to the terminal; an event without
// `content` is a key press, which is passed to `onKey` when it plays
export default function createTimeline(term, stdouts, onKey) {
  const totalTime = stdouts[stdouts.length - 1].time;
  const timeline = new Timeline({length: totalTime, frequency: 10});

  class Marker {
    constructor(event) {
      this.time = event.time;
      this.event = event;
    }
    forward() {
      if (this.event.content != null) {
        term.write(this.event.content);
      } else {
        onKey?.(this.event);
      }
    }
  }

  for (const event of stdouts) {
    timeline.markers.push(new Marker(event));
  }
  return timeline;
}
