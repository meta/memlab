---
id: 'guides-check-a-leak-fix'
---

# Check Whether a Leak Fix Works

After you fix a memory leak, you want proof that the fix works and that it
doesn't add a new leak. This guide runs the same interaction on a leaky and a
fixed version of a small app, then compares the two runs with
`memlab diff-leaks`.

## The Example App

The example app is a single HTML page with an **Open settings** button. The
button opens a dialog with 240 rows and a **Close** button. The page is
[`website/cli-examples/app/index.html`](https://github.com/meta/memlab/blob/main/website/cli-examples/app/index.html)
in the memlab repo.

Closing the dialog removes it from the page, but two things keep it in memory:

- Every dialog is added to a global `openedDialogs` `Set`, and nothing removes
  it.
- Every dialog listens to an app-wide `eventBus`, and never unsubscribes.

Loading the page with `?fixed` runs the fixed version: closing the dialog
removes it from the `Set` and unsubscribes from the `eventBus`.

To run the app, clone the memlab repo and serve that directory on port 3000:

```bash
git clone https://github.com/meta/memlab.git
cd memlab/website/cli-examples/app
python3 -m http.server 3000
```

## 1. Write the Scenarios

The scenario opens the dialog (`action`) and closes it again (`back`). Save it
as `~/memlab/scenarios/leak.js`:

```js
function url() {
  return 'http://localhost:3000/';
}

async function action(page) {
  await page.click('#open-settings');
}

async function back(page) {
  await page.click('#close-settings');
}

module.exports = {action, back, url};
```

The fixed version does the same thing on `?fixed`. Save it as
`~/memlab/scenarios/fixed.js`:

```js
const leak = require('./leak');

function url() {
  return 'http://localhost:3000/?fixed';
}

module.exports = {...leak, url};
```

## 2. Run the Leaky Version

```bash
memlab run --scenario ~/memlab/scenarios/leak.js --work-dir ~/memlab/leak
```

memlab opens the page, takes a heap snapshot after each step, and reports
one leak:

```
MemLab found 1 leak(s)
Number of clusters loaded: 0

--Similar leaks in this run: 386--
--Retained size of leaked objects: 45.3KB--
[Window / http://localhost:3000] (native) @33471 [7.6KB]
  --global_object (shortcut)--->  [Window [JSGlobalObject] / http://localhost:3000] (object) @33803 [46.1KB]
  --openedDialogs (property)--->  [Set] (object) @47967 [76 bytes]
  --table (internal)--->  [<array>] (array) @50805 [60 bytes]
  --5 (internal)--->  [Detached <div class="settings"> (native) @65915 [45.3KB]
  --5 (element)--->  [Detached <div> (native) @71885 [45KB]
  ...
```

Read the trace from the top: the global `openedDialogs` `Set` still holds
the closed dialog's `<div class="settings">`, so the detached element and its
rows stay in memory. [`memlab run`](../cli/run.md) explains each part of this
output.

## 3. Run the Fixed Version

Take the same snapshots on the fixed version, in a separate work directory:

```bash
memlab snapshot --scenario ~/memlab/scenarios/fixed.js --work-dir ~/memlab/fixed
```

`memlab snapshot` runs the scenario like `memlab run`, but doesn't look for
leaks yet.

## 4. Compare the Two Runs

`memlab diff-leaks` looks for leaks in both work directories. The control run
is the baseline, and the treatment run is the one under test:

```bash
memlab diff-leaks --control-work-dir ~/memlab/fixed --treatment-work-dir ~/memlab/leak
```

```
[0] traces from control group
[386] traces from treatment group
MemLab found 1 new leak(s) in the treatment group
```

- `[0] traces from control group`: the fixed version has no leaked objects,
  so the fix works.
- `[386] traces from treatment group`: the leaky version has 386 leaked
  objects (the dialog's elements).
- `1 new leak(s)`: after removing every leak whose trace also appears in the
  control run, one leak is left. memlab prints its trace below, as in step 2.

## Use It on Your Own Changes

The same steps check any change to your app:

1. Run the scenario on the version without your change, with
   `--work-dir` set to a control directory.
2. Run the same scenario on the version with your change, with `--work-dir`
   set to a treatment directory.
3. Run `memlab diff-leaks` on the two directories.

If your change fixes a leak, the leak shows up in the control run and is gone
from the treatment run. If your change adds a leak, `diff-leaks` reports it as
new. Leaks that both versions share are left out, so you only see what your
change did.

To learn more, see [`memlab diff-leaks`](../cli/diff-leaks.md).
