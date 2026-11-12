---
title: memlab class-trend
sidebar_label: class-trend
custom_edit_url: null
---

Track the number of objects per class across a series of heap snapshots, and list the classes that grew at every step

```bash
memlab class-trend --snapshot-dir <DIR_CONTAINING_SNAPSHOTS>
```

## Examples

```bash
memlab class-trend --snapshot-dir <DIR> --name-pattern Detached --output json
```

## Example output

```text
$ memlab class-trend --snapshot-dir /tmp/memlab-example/series/data/cur --top 15
9 snapshots, in order: s1.heapsnapshot, s2.heapsnapshot, s3.heapsnapshot, s4.heapsnapshot, s5.heapsnapshot, s6.heapsnapshot, s7.heapsnapshot, s8.heapsnapshot, s9.heapsnapshot
  0 classes grew at every step; 249 appeared after the first snapshot; 693 classes changed overall
class                                                         type           trend     counts                     delta  self size delta
------------------------------------------------------------  -------------  --------  -------------------------  -----  ---------------
Detached <div>                                                native         appeared  0 > 0 > ... > 720 > 960     +960         +97.5 KB
Detached Text                                                 native         appeared  0 > 0 > ... > 723 > 963     +963         +75.2 KB
(sliced string)                                               sliced string  appeared  0 > 240 > ... > 960 > 960   +960         +18.8 KB
blink::HeapHashTableBacking<blink::HashTable<cppgc::inter...  native         appeared  0 > 2 > ... > 2 > 2           +2         +16.1 KB
system / BytecodeArray                                        code           appeared  0 > 15 > ... > 17 > 17       +17          +1.8 KB
PerformanceEventTiming                                        native         appeared  0 > 2 > ... > 5 > 5           +5          +1.3 KB
blink::SoftNavigationContext                                  native         appeared  0 > 1 > ... > 4 > 4           +4           +928 B
Detached blink::UniqueElementData                             native         appeared  0 > 0 > ... > 6 > 8           +8           +896 B
Detached <button id="close-settings">                         native         appeared  0 > 0 > ... > 3 > 4           +4           +704 B
blink::SelectorQuery                                          native         appeared  0 > 1 > ... > 2 > 2           +2           +528 B
Detached <div class="settings">                               native         appeared  0 > 0 > ... > 3 > 4           +4           +416 B
InteractionContentfulPaint                                    native         appeared  0 > 1 > ... > 4 > 4           +4           +416 B
blink::ScrollAnimator                                         native         appeared  0 > 0 > ... > 3 > 3           +3           +408 B
(constant pool)                                               code           appeared  0 > 12 > ... > 14 > 14       +14           +372 B
system / FeedbackVector                                       code           appeared  0 > 1 > ... > 1 > 1           +1           +360 B
```

## How to read the output

`memlab class-trend` follows the object count of every class across a series of snapshots, in file-name order, and lists the classes that changed the most.

- `trend` is `grows` for a class whose count grew at every step, `appeared` for one that was not in the first snapshot, `grew` or `shrank` for one whose count is higher or lower at the end, and `flat` for one that ended where it started. The classes that grow at every step come first.
- `counts` shows the count in the first two and the last two snapshots.
- `delta` and `self size delta` compare the last snapshot with the first.

In this example, the scenario opens and closes the settings dialog 4 times after the page loads (once, then 3 repeats), taking a snapshot after each step. `Detached <div>` and `Detached Text` grow by 240 every time the dialog closes, and `Detached <div class="settings">` reaches 4: each closed dialog stays in memory. A count that keeps climbing across repetitions of the same action points to a leak. A count that rises once and stays flat (like the `blink::` classes here) is usually a cache or one-time setup.

## Options

 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--top`**: number of rows to report (default 30)
 * **`--name-pattern`**: only report classes whose name matches this case-insensitive regular expression (or plain text)
 * **`--output`**: output format of the report: 'text' (default) or 'json'

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
