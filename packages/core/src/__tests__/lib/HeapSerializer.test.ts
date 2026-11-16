/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import config from '../../lib/Config';
import fs from 'fs';
import HeapParser from '../../lib/HeapParser';
import {dumpNodeHeapSnapshot} from '../../lib/NodeHeap';
import {serializeHeapSnapshot} from '../../lib/HeapSerializer';

beforeEach(() => {
  config.isTest = true;
});

const timeout = 5 * 60 * 1000;

// StringLoader reads the part of the file that holds the string table
// 4 MiB at a time.
const CHUNK_SIZE = 4 * 1024 * 1024;

test(
  'a serialized snapshot reads back non-ASCII strings split across read chunks',
  async () => {
    const sourceFile = dumpNodeHeapSnapshot();
    const outputFile = `${sourceFile}.serialized`;

    try {
      const heap = await HeapParser.parse(sourceFile, {});
      const strings = heap.snapshot.strings;

      // V8 escapes non-ASCII characters as \uXXXX, but serializeHeapSnapshot
      // writes them as raw UTF-8: a 3-byte character and a 4-byte one (a
      // surrogate pair in JavaScript). They are built at runtime so the only
      // copy in the output file is the string table entry added here.
      const markers = [
        ['x', String.fromCodePoint(0x5185)].join(''),
        ['x', String.fromCodePoint(0x1f600)].join(''),
      ];
      // each marker is preceded by an ASCII padding entry
      const firstIndex = strings.length;
      for (const marker of markers) {
        strings.push('', marker);
      }

      // Pad each marker so that its non-ASCII character starts one or two bytes
      // before a chunk boundary, so the boundary splits the character.
      const placements: Array<{start: number; boundary: number}> = [];
      for (let i = 0; i < markers.length; ++i) {
        const padIndex = firstIndex + 2 * i;
        const charBytes = Buffer.from(markers[i].slice(1));
        const splitAfter = i + 1;
        serializeHeapSnapshot(heap, outputFile);
        const offset = fs.readFileSync(outputFile).lastIndexOf(charBytes);
        const boundary = Math.ceil((offset + 1) / CHUNK_SIZE) * CHUNK_SIZE;
        strings[padIndex] = 'p'.repeat(boundary - splitAfter - offset);
        placements.push({start: boundary - splitAfter, boundary});
      }
      serializeHeapSnapshot(heap, outputFile);

      // Check that the boundaries really fall inside the characters, so the
      // test cannot pass without exercising the split.
      const bytes = fs.readFileSync(outputFile);
      for (let i = 0; i < markers.length; ++i) {
        const charBytes = Buffer.from(markers[i].slice(1));
        const {start, boundary} = placements[i];
        expect(bytes.lastIndexOf(charBytes)).toBe(start);
        expect(start < boundary && start + charBytes.length > boundary).toBe(
          true,
        );
      }

      // the file itself holds the right strings
      const expected = JSON.parse(bytes.toString('utf8')).strings;
      expect(expected[firstIndex + 1]).toBe(markers[0]);
      expect(expected[firstIndex + 3]).toBe(markers[1]);

      const reparsed = await HeapParser.parse(outputFile, {});
      const actual = reparsed.snapshot.strings;
      expect(actual.length).toBe(expected.length);
      expect(actual[firstIndex + 1]).toBe(markers[0]);
      expect(actual[firstIndex + 3]).toBe(markers[1]);
      let mismatches = 0;
      for (let i = 0; i < expected.length; ++i) {
        if (actual[i] !== expected[i]) {
          ++mismatches;
        }
      }
      expect(mismatches).toBe(0);
    } finally {
      for (const file of [sourceFile, outputFile]) {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      }
    }
  },
  timeout,
);
