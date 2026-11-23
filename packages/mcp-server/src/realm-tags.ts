/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import {
  nativeContextAttribution,
  SHARED,
  UNATTRIBUTED,
  type NativeContextInfo,
} from './native-context.js';

/**
 * Which kind of realm owns an object, so a finding is not filed against the
 * page when an extension content script, a DevTools isolated world or another
 * frame holds it.
 */
export type RealmKind =
  | 'page'
  | 'extension'
  | 'devtools'
  | 'secondary'
  | 'cross-origin'
  | 'untagged'
  | 'detached';

export const REALM_KIND_LABEL: Record<RealmKind, string> = {
  page: 'page',
  extension: 'browser extension',
  devtools: 'DevTools',
  secondary:
    'same-origin secondary realm (iframe, popout, or an isolated world such as a DevTools or extension script)',
  'cross-origin': 'cross-origin frame',
  untagged: 'untagged realm',
  detached: 'detached realm',
};

const EXTENSION_RE = /^(chrome|moz|safari-web|ms-browser)-extension:\/\//;

export interface RealmClasses {
  /** The page's NativeContext ordinal, or -1 when none could be chosen. */
  page: number;
  pageLabel: string;
  kindByOrdinal: Map<number, RealmKind>;
  labelByOrdinal: Map<number, string>;
  owner: Int32Array;
}

function origin(label: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+/i.exec(label);
  return m == null ? label : m[0];
}

/** Picks the page realm and classifies every other realm against it. */
export function classifyRealmList(contexts: readonly NativeContextInfo[]): {
  page: number;
  kinds: Map<number, RealmKind>;
} {
  const kinds = new Map<number, RealmKind>();
  const live = contexts.filter(c => !c.detached);
  const web = live.filter(c => /^https?:\/\//.test(c.label));
  const pool =
    web.length > 0
      ? web
      : live.filter(
          c =>
            !EXTENSION_RE.test(c.label) && !c.label.startsWith('devtools://'),
        );
  let page: NativeContextInfo | null = null;
  for (const c of pool) {
    if (page == null || c.attributedSize > page.attributedSize) page = c;
  }
  const pageOrigin = page == null ? '' : origin(page.label);
  for (const c of contexts) {
    let kind: RealmKind;
    if (page != null && c.ordinal === page.ordinal) kind = 'page';
    else if (c.detached) kind = 'detached';
    else if (EXTENSION_RE.test(c.label)) kind = 'extension';
    else if (c.label.startsWith('devtools://')) kind = 'devtools';
    else if (c.label === '') kind = 'untagged';
    else if (origin(c.label) === pageOrigin) kind = 'secondary';
    else kind = 'cross-origin';
    kinds.set(c.ordinal, kind);
  }
  return {page: page?.ordinal ?? -1, kinds};
}

/**
 * Whether memory owned by realm `o` is not the page's. A detached realm is not
 * another realm: page code that still holds a removed frame is a page leak.
 */
export function isNonPageRealm(
  classes: Pick<RealmClasses, 'page' | 'kindByOrdinal'>,
  o: number,
): boolean {
  return (
    classes.page >= 0 &&
    o >= 0 &&
    o !== classes.page &&
    classes.kindByOrdinal.get(o) !== 'detached'
  );
}

const cache = new WeakMap<IHeapSnapshot, RealmClasses | null>();

function countNativeContexts(snapshot: IHeapSnapshot): number {
  let n = 0;
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (
      node.name.startsWith('system / NativeContext') ||
      node.name.startsWith('Detached system / NativeContext')
    ) {
      n++;
    }
  });
  return n;
}

/** Realm classes for a snapshot with more than one realm, else null. */
export function realmClasses(snapshot: IHeapSnapshot): RealmClasses | null {
  if (cache.has(snapshot)) return cache.get(snapshot) ?? null;
  let result: RealmClasses | null = null;
  if (countNativeContexts(snapshot) > 1) {
    const attribution = nativeContextAttribution(snapshot);
    const {page, kinds} = classifyRealmList(attribution.contexts);
    const labels = new Map(attribution.contexts.map(c => [c.ordinal, c.label]));
    result = {
      page,
      pageLabel: labels.get(page) ?? '',
      kindByOrdinal: kinds,
      labelByOrdinal: labels,
      owner: attribution.owner,
    };
  }
  cache.set(snapshot, result);
  return result;
}

/** The kind and label of the realm that alone owns `node`, or null. */
export function ownerRealm(
  snapshot: IHeapSnapshot,
  node: IHeapNode,
): {kind: RealmKind; label: string} | null {
  const classes = realmClasses(snapshot);
  if (classes == null) return null;
  const o = classes.owner[node.nodeIndex];
  if (o === SHARED || o === UNATTRIBUTED) return null;
  const kind = classes.kindByOrdinal.get(o);
  if (kind == null) return null;
  // With no page realm, only kinds read off the label alone are known.
  if (classes.page < 0 && kind !== 'extension' && kind !== 'devtools') {
    return null;
  }
  return {kind, label: classes.labelByOrdinal.get(o) ?? ''};
}

/**
 * A short tag such as `[realm: browser extension chrome-extension://abc…]` when
 * `node` belongs to a realm other than the page, else ''.
 */
export function realmTag(snapshot: IHeapSnapshot, node: IHeapNode): string {
  const realm = ownerRealm(snapshot, node);
  if (realm == null || realm.kind === 'page') return '';
  const label =
    realm.label.length > 44 ? `${realm.label.slice(0, 43)}…` : realm.label;
  const kind =
    realm.kind === 'secondary'
      ? 'same-origin secondary realm'
      : REALM_KIND_LABEL[realm.kind];
  return `[realm: ${kind}${label ? ` ${label}` : ''}]`;
}

/** The header line naming a non-page owner, or null. */
export function realmNotice(
  snapshot: IHeapSnapshot,
  node: IHeapNode,
): string | null {
  const realm = ownerRealm(snapshot, node);
  if (realm == null || realm.kind === 'page' || realm.kind === 'detached') {
    return null;
  }
  return `⚠ **Not the page's memory:** @${node.id} is owned by a ${REALM_KIND_LABEL[realm.kind]}${realm.label ? ` (\`${realm.label}\`)` : ''}, not the page realm. Do not file it as an app finding without showing the page code that creates or holds it.`;
}
