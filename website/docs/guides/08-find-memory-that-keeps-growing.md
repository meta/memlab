---
id: 'guides-find-memory-that-keeps-growing'
---

# Find Memory That Keeps Growing

Some leaks only show up when an action repeats: each time a user opens and
closes a dialog, a little more memory stays behind. This guide repeats an
interaction a few times, takes a heap snapshot after every step, and asks
memlab what keeps growing.

It uses the example app and the `leak.js` scenario from
[Check Whether a Leak Fix Works](./07-check-a-leak-fix.md). Follow that guide's
first two sections to serve the app and save the scenario.

## 1. Repeat the Interaction

Add a `repeat` function to the scenario. memlab runs `action` and `back` once,
then as many more times as `repeat` returns. Save this as
`~/memlab/scenarios/repeat.js`:

```js
const leak = require('./leak');

function repeat() {
  return 3;
}

module.exports = {...leak, repeat};
```

## 2. Take a Snapshot After Every Step

```bash
memlab snapshot --scenario ~/memlab/scenarios/repeat.js --full --work-dir ~/memlab/series
```

`--full` takes a heap snapshot after every step instead of only the baseline,
target, and final ones. Here that's 9 snapshots: one after the page loads,
then one after each of the 4 times the dialog opens and the 4 times it closes.
They are saved as `s1.heapsnapshot` to `s9.heapsnapshot` in
`~/memlab/series/data/cur`.

## 3. See Which Classes Grow

`memlab class-trend` counts the objects of each class in every snapshot and
lists the classes that changed the most:

```bash
memlab class-trend --snapshot-dir ~/memlab/series/data/cur --top 15
```

```
9 snapshots, in order: s1.heapsnapshot, s2.heapsnapshot, s3.heapsnapshot, s4.heapsnapshot, s5.heapsnapshot, s6.heapsnapshot, s7.heapsnapshot, s8.heapsnapshot, s9.heapsnapshot
  0 classes grew at every step; 249 appeared after the first snapshot; 693 classes changed overall
class                                                         type           trend     counts                     delta  self size delta
------------------------------------------------------------  -------------  --------  -------------------------  -----  ---------------
Detached <div>                                                native         appeared  0 > 0 > ... > 720 > 960     +960         +97.5 KB
Detached Text                                                 native         appeared  0 > 0 > ... > 723 > 963     +963         +75.2 KB
(sliced string)                                               sliced string  appeared  0 > 240 > ... > 960 > 960   +960         +18.8 KB
...
Detached <button id="close-settings">                         native         appeared  0 > 0 > ... > 3 > 4           +4           +704 B
...
Detached <div class="settings">                               native         appeared  0 > 0 > ... > 3 > 4           +4           +416 B
```

`counts` shows the first two and the last two snapshots. After 4 rounds there
are 960 detached `<div>` elements (4 dialogs of 240 rows each) and 4 detached
`<div class="settings">`: every closed dialog is still in memory.

Look for counts that climb with every round, like these. A count that rises
once and then stays flat is usually a cache or one-time setup, not a leak.

## 4. Find the Collection That Holds Them

Leaked objects often pile up in a `Map`, a `Set`, or an array.
`memlab analyze unbound-collection` lists the collections whose number of
entries keeps growing:

```bash
memlab analyze unbound-collection --snapshot-dir ~/memlab/series/data/cur
```

```
Top growing objects in sizes:
 (Use `memlab trace --node-id=@ID` to get trace)

· Set [object](@47967):  1 > 2 > 2 > 3 > 3 > 4 > 4 > 5 > 5
```

The `Set` gains one entry each time the dialog opens (snapshots 2, 4, 6,
and 8) and never loses one when it closes.

## 5. Find Out Who Holds the Collection

Pass the `Set`'s id to `memlab trace`, with the last snapshot:

```bash
memlab trace --snapshot ~/memlab/series/data/cur/s9.heapsnapshot --node-id @47967
```

```
[Window / http://localhost:3000] (native) @33471 [7.6KB]
  --global_object (shortcut)--->  [Window [JSGlobalObject] / http://localhost:3000] (object) @33803 [46.1KB]
  --openedDialogs (property)--->  [Set] (object) @47967 [76 bytes]
```

It's the global `openedDialogs`. The fix is to delete each dialog from the
`Set` when the dialog closes.

## Other Ways to Look at Growth

These commands read the same snapshot directory:

- [`memlab analyze unbound-object`](../cli/analyze/unbound-object.md) lists
  single objects whose retained size keeps growing.
- [`memlab analyze unbound-shape`](../cli/analyze/unbound-shape.md) groups
  objects by shape (their class and property names) and lists the shapes
  whose total retained size keeps growing.
- [`memlab analyze collections-with-stale`](../cli/analyze/collections-with-stale.md)
  lists collections that hold stale objects: detached DOM elements and
  unmounted React Fiber nodes that the app no longer uses.
