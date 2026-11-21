/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * Unit tests for string identity under the snapshot's 1,024-char cut
 * (string-identity.ts, flattenString's cut counting, duplicated_strings'
 * cut note): strings of different lengths that share a cut prefix are never
 * one duplicate group, and every cut is said out loud.
 *
 *   npm run build-pkg && npm run test-units
 *
 * Runs against the BUILT dist/.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const identityJs = path.join(dist, 'string-identity.js');
if (!fs.existsSync(identityJs)) {
  console.error(
    'check-full-string-identity: dist/string-identity.js is missing; build first.',
  );
  process.exit(1);
}
const {
  SNAPSHOT_STRING_LIMIT,
  stringIdentityKey,
  identityKeyText,
  identityKeyCut,
  isSnapshotCut,
  estimatedFullLength,
  cutPrefixGroups,
} = await import(pathToFileURL(identityJs).href);
const {flattenString} = await import(
  pathToFileURL(path.join(dist, 'utils.js')).href
);
const {cutNote} = await import(
  pathToFileURL(path.join(dist, 'tools', 'duplicated-strings.js')).href
);

const PREFIX = '24291545363825955{"RELAY_INCREMENTAL_DELIVERY":true,'.padEnd(
  SNAPSHOT_STRING_LIMIT,
  'x',
);

/** A flat string node as the snapshot records it: name cut at 1,024. */
function flat(text, selfSize, id = 1) {
  return {
    id,
    type: 'string',
    name: text.slice(0, SNAPSHOT_STRING_LIMIT),
    self_size: selfSize ?? 12 + text.length + ((4 - (text.length % 4)) % 4),
    references: [],
  };
}

function rope(first, second) {
  return {
    id: 99,
    type: 'concatenated string',
    name: '(concatenated string)',
    self_size: 20,
    references: [
      {name_or_index: 'first', toNode: first},
      {name_or_index: 'second', toNode: second},
    ],
  };
}

test('a short string keys on its text alone (unchanged)', () => {
  const n = flat('hello world');
  assert.equal(stringIdentityKey(n), 'hello world');
  assert.equal(identityKeyText('hello world'), 'hello world');
  assert.equal(identityKeyCut('hello world'), null);
  assert.equal(isSnapshotCut(n), false);
});

test('cut strings of different lengths get different keys', () => {
  const a = flat(PREFIX, 1120);
  const b = flat(PREFIX, 1136);
  const c = flat(PREFIX, 1136);
  assert.equal(a.name, b.name);
  assert.notEqual(stringIdentityKey(a), stringIdentityKey(b));
  assert.equal(stringIdentityKey(b), stringIdentityKey(c));
  assert.equal(identityKeyText(stringIdentityKey(a)), PREFIX);
  const cut = identityKeyCut(stringIdentityKey(b));
  assert.equal(cut.text, PREFIX);
  assert.equal(cut.selfSize, 1136);
  assert.equal(cut.fullLength, 1124);
});

test('an exactly-1,024-char string is not cut, with or without compression', () => {
  assert.equal(isSnapshotCut(flat(PREFIX, 1036)), false);
  assert.equal(isSnapshotCut(flat(PREFIX, 1040)), false);
  assert.equal(identityKeyCut(stringIdentityKey(flat(PREFIX, 1036))), null);
  assert.equal(isSnapshotCut(flat(PREFIX, 1120)), true);
});

test('two-byte strings estimate half the payload', () => {
  const wide = 'é€'.repeat(SNAPSHOT_STRING_LIMIT / 2);
  assert.equal(estimatedFullLength(wide, 12 + 2 * 2000), 2000);
  assert.equal(isSnapshotCut(flat(wide, 12 + 2 * 1024)), false);
  assert.equal(isSnapshotCut(flat(wide, 12 + 2 * 2000)), true);
});

test('cutPrefixGroups counts the lengths behind one prefix', () => {
  const index = new Map();
  for (const [size, n] of [
    [1120, 22],
    [1136, 143],
    [1844, 4],
  ]) {
    index.set(stringIdentityKey(flat(PREFIX, size)), {count: n});
  }
  index.set('short', {count: 9});
  const groups = cutPrefixGroups(index);
  assert.deepEqual(groups.get(PREFIX), {groups: 3, strings: 169});
  assert.equal(groups.size, 1);
});

test('cutNote states the cut, the full length and the distinct floor', () => {
  const one = cutNote(80, {
    full_length: 1124,
    prefix_size_groups: 1,
    prefix_strings: 143,
  });
  assert.match(one, /shown 80 of ~1,124 chars/);
  assert.match(one, /first 1,024/);
  assert.doesNotMatch(one, /distinct/);
  const many = cutNote(80, {
    full_length: 1124,
    prefix_size_groups: 37,
    prefix_strings: 1772,
  });
  assert.match(many, /1,772 strings share this prefix in 37 different lengths/);
  assert.match(many, /at least 37 distinct values/);
});

test('flattenString counts parts the snapshot cut', () => {
  const whole = flattenString(flat('abc'));
  assert.equal(whole.cutParts, 0);
  assert.equal(whole.missingChars, 0);
  const cut = flattenString(flat(PREFIX, 1136));
  assert.equal(cut.value.length, SNAPSHOT_STRING_LIMIT);
  assert.equal(cut.cutParts, 1);
  assert.equal(cut.missingChars, 100);
  const r = flattenString(rope(flat(PREFIX, 1136), flat('|tail')));
  assert.equal(r.cutParts, 1);
  assert.equal(r.missingChars, 100);
  assert.ok(r.value.endsWith('|tail'));
});
