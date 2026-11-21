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
 * String identity under the snapshot's 1,024-character cut.
 *
 * V8 writes at most the first 1,024 characters of a string into the snapshot
 * (`--heap-snapshot-string-limit`), so every string longer than that shares
 * its node name with every other string that starts the same way. Grouping by
 * name alone reported 1,070 Relay cache keys as "1,070 copies of one string"
 * when their self sizes span 36 values (1,120–1,844 B), and a hand-written
 * `s.length + s.slice(-500)` key read every base64 thumbnail as 1,024 chars
 * long. The self size is the only record of the real length, so a cut name
 * is identified by name AND self size: two strings of different lengths
 * never share a key. Copies that share both still match only on their first
 * 1,024 characters; what follows is not in the snapshot.
 */

export const SNAPSHOT_STRING_LIMIT = 1024;

// Never part of a node name at the cut, which ends in the 1,024th character.
const KEY_SEP = '\u0000';

type StringLike = {name: string; self_size: number; type: string};

function isTwoByte(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0xff) return true;
  }
  return false;
}

/**
 * The full character count of a flat string whose name is cut, from its self
 * size: a 12-byte header (compressed pointers) plus one or two bytes a
 * character, rounded up to 4. Exact to within 3 characters.
 */
export function estimatedFullLength(name: string, selfSize: number): number {
  const payload = Math.max(0, selfSize - 12);
  const chars = isTwoByte(name) ? Math.floor(payload / 2) : payload;
  return Math.max(chars, name.length);
}

/**
 * True when this flat string's name is a prefix the snapshot cut, not its
 * whole value: the name is at the limit and the self size holds more
 * characters than that (with a 16-byte header, so an uncompressed-pointer
 * snapshot's exactly-1,024-character string does not count).
 */
export function isSnapshotCut(node: StringLike): boolean {
  if (node.type !== 'string') return false;
  const name = node.name;
  if (name.length < SNAPSHOT_STRING_LIMIT) return false;
  const payload = node.self_size - 16;
  return (isTwoByte(name) ? payload / 2 : payload) > name.length;
}

/**
 * The duplicate-grouping key of a flat string node: its text, plus its self
 * size when the text is at the snapshot's cut. Unchanged (the text alone)
 * for every string shorter than the limit.
 */
export function stringIdentityKey(node: StringLike): string {
  const name = node.name;
  return name.length >= SNAPSHOT_STRING_LIMIT
    ? `${name}${KEY_SEP}${node.self_size}`
    : name;
}

/** The text part of a {@link stringIdentityKey}. */
export function identityKeyText(key: string): string {
  if (key.length <= SNAPSHOT_STRING_LIMIT) return key;
  const at = key.lastIndexOf(KEY_SEP);
  return at >= SNAPSHOT_STRING_LIMIT ? key.slice(0, at) : key;
}

/**
 * For a key whose string the snapshot cut: the text it keeps and the full
 * length estimated from the self size. Null for a whole value.
 */
export function identityKeyCut(
  key: string,
): {text: string; selfSize: number; fullLength: number} | null {
  const text = identityKeyText(key);
  if (text.length === key.length) return null;
  const selfSize = Number(key.slice(text.length + 1));
  if (
    !isSnapshotCut({name: text, self_size: selfSize, type: 'string'}) ||
    !Number.isFinite(selfSize)
  ) {
    return null;
  }
  return {text, selfSize, fullLength: estimatedFullLength(text, selfSize)};
}

/**
 * Per cut prefix, how many distinct-size groups (and strings) share it. A
 * prefix with N size groups is at least N different values, however the
 * strings look in the snapshot.
 */
export function cutPrefixGroups(
  entries: Iterable<[string, {count: number}]>,
): Map<string, {groups: number; strings: number}> {
  const out = new Map<string, {groups: number; strings: number}>();
  for (const [key, stats] of entries) {
    if (key.length <= SNAPSHOT_STRING_LIMIT) continue;
    const cut = identityKeyCut(key);
    if (cut == null) continue;
    const row = out.get(cut.text) ?? {groups: 0, strings: 0};
    row.groups++;
    row.strings += stats.count;
    out.set(cut.text, row);
  }
  return out;
}
