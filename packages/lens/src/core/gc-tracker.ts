/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import type {Nullable} from './types';

type SentinelKind = 'young' | 'old';

/**
 * Counts full (old generation) garbage collections without --expose-gc.
 *
 * A sentinel object registered in a FinalizationRegistry is reported some
 * time after the GC that collected it. A fresh, unreferenced sentinel dies in
 * the next GC of any kind, so it signals that a GC happened. The counted
 * sentinel is held until two of those GCs have passed, which moves it to the
 * old generation; after it is released, only a full GC can collect it. Each
 * time it is collected the count goes up and a new one is armed.
 *
 * The count is a lower bound: full GCs that run while a new sentinel is still
 * being held are not counted.
 */
export class GCTracker {
  #count = 0;
  #registry: Nullable<FinalizationRegistry<SentinelKind>> = null;
  #heldSentinel: Nullable<object> = null;
  #gcsWhileHeld = 0;
  #isDisposed = false;

  constructor() {
    if (typeof FinalizationRegistry === 'undefined') {
      return;
    }
    this.#registry = new FinalizationRegistry(kind => this.#onCollected(kind));
    this.#armOldSentinel();
    this.#armYoungSentinel();
  }

  isSupported(): boolean {
    return this.#registry != null;
  }

  /** Full GCs seen since this tracker was created */
  getCount(): number {
    return this.#count;
  }

  dispose(): void {
    this.#isDisposed = true;
    this.#heldSentinel = null;
  }

  #armOldSentinel(): void {
    const sentinel = {};
    this.#heldSentinel = sentinel;
    this.#gcsWhileHeld = 0;
    this.#registry?.register(sentinel, 'old');
  }

  #armYoungSentinel(): void {
    this.#registry?.register({}, 'young');
  }

  #onCollected(kind: SentinelKind): void {
    if (this.#isDisposed) {
      return;
    }
    if (kind === 'old') {
      ++this.#count;
      this.#armOldSentinel();
      return;
    }
    if (this.#heldSentinel != null && ++this.#gcsWhileHeld >= 2) {
      this.#heldSentinel = null;
    }
    this.#armYoungSentinel();
  }
}
