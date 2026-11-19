# MemLens

MemLens is a lightweight, in-browser lens for spotting memory issues in React apps. It detects and visualizes:

- Detached DOM elements that are still alive after a full garbage collection
- Unmounted React fibers that are still alive after a full garbage collection, grouped by component
- Listeners left on detached elements, and `window`/`document` listener call sites whose count keeps growing
- High-level DOM and heap usage stats (overlay header)

It can run as a one-line console snippet or as a small library you embed in dev builds.

### Key features

- **GC-confirmed results**: a detached element or unmounted fiber is reported only once it has survived a full GC after it left the page, so garbage the browser has not collected yet is not reported as a leak. Full GCs are counted with a `FinalizationRegistry` sentinel; no `--expose-gc` flag is needed
- **Captured at removal**: the position and React component stack of an element are recorded right before it is removed from the DOM, so elements that live for less than a scan interval are still outlined and attributed
- **No DOM sweep while running**: a started scanner looks only at removed elements and walks the React trees from their roots
- **Visual overlay**: outlines detached elements as soon as they leave the page, in faded gray dashes until they survive a GC and in teal after; the widget shows counts, leaked components, listener growth and the React component stack of the selected element, and copies a JSON report
- **Shadow DOM**: open shadow roots, and closed ones attached while MemLens runs, are covered
- **Non-intrusive**: uses a transparent overlay, never lets its own failures reach the app's DOM or listener calls, and restores everything it patched when stopped

### Browser support

- Requires browsers with WeakRef/FinalizationRegistry support (e.g. modern Chrome, Edge, Safari, Firefox). In older browsers the tool may not function.
- Without `FinalizationRegistry`, GCs cannot be counted and every reachable detached element and unmounted fiber is reported, as in earlier versions.

---

### Quick start

#### Option A: Run from the browser console (CDN)

Paste this in your app page:

```js
(() => {
  const s = document.createElement('script');
  s.src = 'https://unpkg.com/@memlab/lens/dist/memlens.run.bundle.min.js';
  s.crossOrigin = 'anonymous';
  document.head.appendChild(s);
})();
```

This injects and starts MemLens with the interactive overlay.

#### Option B: Run from the browser console (local build)

Copy the contents of `packages/lens/dist/memlens.run.bundle.min.js` (or `packages/lens/dist/memlens.run.bundle.js`) and paste into the browser's web console. The overlay starts immediately.

#### Option C: Programmatic scanner (UMD global)

Load the library bundle and use the `MemLens` global:

```html
<script src="https://unpkg.com/@memlab/lens/dist/memlens.lib.bundle.min.js"></script>
<script>
  // Create a scanner (no overlay by default; use the run bundle for overlay)
  const scan = MemLens.createReactMemoryScan({
    isDevMode: true,
    scanIntervalMs: 1000,
    trackEventListenerLeaks: true, // optional
  });

  const unsubscribe = scan.subscribe((result) => {
    console.log('[MemLens]', {
      detachedAfterGC: result.totalDetachedElementsSurvivingGC,
      leakedFibers: result.leakedFibers.length,
      eventListenerLeaks: result.eventListenerLeaks,
      globalListenerSites: result.globalListenerSites,
    });
  });

  scan.start();

  // A JSON-serializable summary, e.g. to return from page.evaluate()
  console.log(scan.getReport());

  // Later: scan.stop(); unsubscribe(); scan.dispose();
</script>
```

Note: The visualization overlay is provided by the self-starting "run" bundle (Option A/B/D). The library bundle focuses on scanning APIs. The run bundle exposes the scanner it started as `window.__memlens`, so `window.__memlens.getReport()` works from the console or from a tool driving the page.

#### Option D: Node/Puppeteer injection

`@memlab/lens` exposes a helper to retrieve the self-starting bundle as a string for script injection:

```js
// Node
const {getBundleContent} = require('@memlab/lens');

// Puppeteer example
await page.addScriptTag({content: getBundleContent()});
```

---

### Overlay controls and interactions

- **Status line**: total elements, detached elements that survived a GC, and how many are still waiting for one
- **Summary row**: leaked React components, listeners on detached elements, growing `window`/`document` listener sites, and the number of GCs seen
- **Copy report**: copies `getReport()` as JSON (and logs it to the console)
- **Outlines**: a gray dashed outline is a detached element still waiting for a GC, which may yet be collected; it turns teal and dotted once the element survives one
- **Toggle switch**: Show/hide all overlay rectangles
- **Select/pin**: Click a rectangle to pin/unpin the current selection
- **Hover**: Reveal the selection chain of related detached elements
- **Component stack panel**: Shows the React component stack of the selected element
- **Keyboard**: Press `D` to temporarily ignore the currently selected element in the overlay (ignored while typing in a text field)
- **Widget**: The control widget is draggable

Notes:
- The overlay ignores its own UI elements and won’t count them as part of the page.
- In dev mode, MemLens logs basic timing and scan stats to the console.

---

### Configuration (CreateOptions)

```ts
type CreateOptions = {
  isDevMode?: boolean;                 // enable console logs and the overlay extension
  subscribers?: Array<(r) => void>;    // observers of each scan result
  extensions?: Array<BasicExtension>;  // e.g., DOMVisualizationExtension
  scanIntervalMs?: number;             // default 1000
  trackEventListenerLeaks?: boolean;   // track element, window and document listeners
  detachedElementMinGCCount?: number;  // full GCs a detached element must survive (default 1)
  leakedFiberMinGCCount?: number;      // full GCs an unmounted fiber must survive (default 1)
  captureOnRemoval?: boolean;          // record position/component stack right before removal (default true)
};
```

Core API (`ReactMemoryScan`):
- `start()`, `pause()`, `stop()`, `dispose()`
- `scan()`: run one scan and return the `ScanResult`
- `getReport({maxDetachedElements})`: run one scan and return a JSON-serializable `MemLensReport`
- `getDetachedDOMInfo({includeUnconfirmed})`: detached elements that survived a GC (or all of them)
- `subscribe(cb) => () => void`
- `registerExtension(ext) => () => void`

Each detached element in a report has an `id` of the form `memory-id-N@`. MemLens also stores it on the element as `detachedElementIdStr`, so the same element can be searched for in a heap snapshot.

### How it works

- While the scanner runs, the DOM methods that remove nodes (`removeChild`, `replaceChild`, `remove`, `replaceWith`, `replaceChildren`, and the `innerHTML`, `outerHTML` and `textContent` setters) are wrapped to record each removed element's position and component stack before it leaves the DOM. A `MutationObserver` catches the removals they don't cover. Rect reads stop after 4 ms per synchronous run of removals, so commits that remove many nodes are not slowed down; the rest keep the rect recorded when they were added.
- Each scan looks at the removed elements still alive and walks the React fiber trees from their roots (found once at `start()` and when a new root first renders).
- A full GC is counted when a sentinel object that has been promoted to the old generation is collected. A detached element or unmounted fiber is reported once the count has advanced past the configured minimum since it left the page.
- With `trackEventListenerLeaks`, `addEventListener`/`removeEventListener` are wrapped. Listeners are matched like the DOM matches them (type, callback and capture), and listeners the browser removes itself (`once`, aborted `signal`) are forgotten.

### Limitations

- Only the top document and its shadow roots are covered: iframes and popup windows are not.
- Leaks that hold no DOM element or fiber (caches, stores, timers) are out of scope; use heap snapshots with memlab for those.
- A full GC that runs while a new GC sentinel is being promoted is not counted, so the GC count is a lower bound.
- Surviving a GC means the element or fiber was reachable at that GC, not that it will stay so. React keeps the fibers it deleted in the parent's alternate fiber (`deletions`) until the parent renders twice more, so elements removed by a commit can be reported for a while and then go away. An element reported across several interactions is the stronger signal.

### Build

```bash
# from packages/lens
npm run build
# or
webpack
```

### Test

1) Install Playwright dependencies (first time):

```bash
npx playwright install
npx playwright install-deps
```

2) Run tests:

```bash
npm run test:e2e
```

3) Manual test: open `src/tests/manual/todo-list/todo-with-run.bundle.html` in a browser, or copy/paste `dist/memlens.run.bundle.js` to the DevTools console on any React page.

---

### Learn more

Please check out this
[tutorial page](https://meta.github.io/memlab/docs/guides/visually-debug-memory-leaks-with-memlens)
on how to use MemLens (a debugging utility) to visualize memory leaks in the
browser for easier memory debugging.

### License

MIT © Meta Platforms, Inc.
