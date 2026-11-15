/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

// The commands that `capture.js` runs to record the example terminal output
// shown on each CLI doc page. `id` names the output file: the full command
// with spaces replaced by `-` (e.g. `analyze-detached-DOM`).
//
// `args(ctx)` returns the arguments after `memlab`. `ctx` provides:
//   ctx.scenario(name)    path of `scenarios/<name>.js`
//   ctx.workDir(name)     a work directory, shared by the examples using it
//   ctx.snapshot(name, n) `s<n>.heapsnapshot` in that work directory
//   ctx.snapshotDir(name) the directory holding that work directory's snapshots
//   ctx.tmpFile(name)     a scratch file path
//   ctx.nodeId(name, className) id of a `className` object in the final
//                         snapshot of a work directory
//
// `setup` entries run first and are not captured; `required` entries always
// run because later examples read their output. `browser` entries get the
// Chromium binary. `tui` entries are full-screen UIs: the visible screen is
// captured after `waitMs` (and, if given, after typing the `input(ctx)`
// command and waiting `afterInputMs`), then `quitKeys` are sent. A `tui` entry
// with a `size` runs in a terminal of that size. With `replay` steps, the
// session is also recorded for the replay on the doc page: each step presses
// `keys` and waits `waitMs`, and the doc page shows the keys with the step's
// `caption`.

const examples = [
  // runs whose snapshots the other examples read
  {
    id: 'run',
    required: true,
    browser: true,
    args: (ctx) => [
      'run',
      '--scenario',
      ctx.scenario('leak'),
      '--work-dir',
      ctx.workDir('leak'),
    ],
  },
  {
    id: 'setup-fixed',
    setup: true,
    browser: true,
    args: (ctx) => [
      'snapshot',
      '--scenario',
      ctx.scenario('fixed'),
      '--work-dir',
      ctx.workDir('fixed'),
    ],
  },
  {
    id: 'setup-series',
    setup: true,
    browser: true,
    args: (ctx) => [
      'snapshot',
      '--scenario',
      ctx.scenario('repeat'),
      '--full',
      '--work-dir',
      ctx.workDir('series'),
    ],
  },

  // E2E commands
  {
    id: 'snapshot',
    browser: true,
    args: (ctx) => [
      'snapshot',
      '--scenario',
      ctx.scenario('leak'),
      '--work-dir',
      ctx.workDir('snapshot'),
    ],
  },
  {
    id: 'warmup',
    browser: true,
    args: (ctx) => ['warmup', '--scenario', ctx.scenario('leak')],
  },
  {
    id: 'warmup-and-snapshot',
    browser: true,
    args: (ctx) => [
      'warmup-and-snapshot',
      '--scenario',
      ctx.scenario('leak'),
      '--work-dir',
      ctx.workDir('warmup-and-snapshot'),
    ],
  },
  {
    id: 'measure',
    browser: true,
    args: (ctx) => [
      'measure',
      '--scenario',
      ctx.scenario('leak'),
      '--run-num',
      '2',
      '--work-dir',
      ctx.workDir('measure'),
    ],
  },

  // leak detection
  {
    id: 'find-leaks',
    args: (ctx) => ['find-leaks', '--work-dir', ctx.workDir('leak')],
  },
  {
    id: 'diff-leaks',
    args: (ctx) => [
      'diff-leaks',
      '--control-work-dir',
      ctx.workDir('fixed'),
      '--treatment-work-dir',
      ctx.workDir('leak'),
    ],
  },
  {
    id: 'trace',
    args: (ctx) => [
      'trace',
      '--snapshot',
      ctx.snapshot('leak', 3),
      '--node-id',
      ctx.nodeId('leak', 'SettingsDialog'),
    ],
  },

  // heap inspection
  {
    id: 'heap-stats',
    args: (ctx) => ['heap-stats', '--snapshot', ctx.snapshot('leak', 3)],
  },
  {
    id: 'snapshot-header',
    args: (ctx) => ['snapshot-header', '--snapshot', ctx.snapshot('leak', 3)],
  },
  {
    id: 'class-histogram',
    args: (ctx) => [
      'class-histogram',
      '--snapshot',
      ctx.snapshot('leak', 3),
      '--top',
      '15',
    ],
  },
  {
    id: 'class-diff',
    args: (ctx) => [
      'class-diff',
      '--baseline',
      ctx.snapshot('leak', 1),
      '--target',
      ctx.snapshot('leak', 3),
      '--top',
      '15',
    ],
  },
  {
    id: 'class-trend',
    args: (ctx) => [
      'class-trend',
      '--snapshot-dir',
      ctx.snapshotDir('series'),
      '--top',
      '15',
    ],
  },
  {
    id: 'dom-audit',
    args: (ctx) => ['dom-audit', '--snapshot', ctx.snapshot('leak', 2)],
  },
  {
    id: 'find-objects',
    args: (ctx) => [
      'find-objects',
      '--snapshot',
      ctx.snapshot('leak', 3),
      '--name-pattern',
      '^SettingsDialog$',
    ],
  },
  {
    id: 'native-contexts',
    args: (ctx) => ['native-contexts', '--snapshot', ctx.snapshot('leak', 3)],
  },
  {
    id: 'script-census',
    args: (ctx) => ['script-census', '--snapshot', ctx.snapshot('leak', 3)],
  },
  {
    id: 'sliced-strings',
    args: (ctx) => ['sliced-strings', '--snapshot', ctx.snapshot('leak', 3)],
  },
  {
    id: 'weakref-census',
    args: (ctx) => ['weakref-census', '--snapshot', ctx.snapshot('leak', 3)],
  },
  {
    id: 'anonymize',
    args: (ctx) => [
      'anonymize',
      '--snapshot',
      ctx.snapshot('leak', 3),
      '--output',
      ctx.tmpFile('anonymized.heapsnapshot'),
    ],
  },
  {
    id: 'heap',
    tui: {
      waitMs: 15000,
      input: (ctx) => `trace --node-id ${ctx.nodeId('leak', 'SettingsDialog')}`,
      afterInputMs: 5000,
      quitKeys: ['C-c', 'C-c'],
    },
    args: (ctx) => ['heap', '--snapshot', ctx.snapshot('leak', 3)],
  },
  {
    id: 'view-heap',
    tui: {
      size: {columns: 100, rows: 30},
      waitMs: 15000,
      // starts on the detached dialog, browses its referrers (full screen
      // too), then walks its retainer trace up to the `openedDialogs` Set that
      // keeps it alive and inspects the Set
      replay: [
        {
          keys: ['1'],
          waitMs: 1500,
          caption: 'Referrers: the objects that point to the detached dialog',
        },
        {
          keys: ['Down'],
          waitMs: 1000,
          caption: 'select a referrer, and the other panels show it',
        },
        {keys: ['Down'], waitMs: 1200, caption: 'the next referrer'},
        {keys: ['f'], waitMs: 2500, caption: 'show the panel full screen'},
        {keys: ['q'], waitMs: 1200, caption: 'leave full screen'},
        {
          keys: ['3'],
          waitMs: 1500,
          caption: 'Clustered Objects: back to the detached dialog',
        },
        {
          keys: ['6'],
          waitMs: 1800,
          caption: 'Retainer Trace: the path that keeps the dialog alive',
        },
        {keys: ['Down'], waitMs: 1000, caption: 'move along the trace'},
        {
          keys: ['Down'],
          waitMs: 1800,
          caption: 'to the openedDialogs Set that holds the dialog',
        },
        {
          keys: ['Enter'],
          waitMs: 1800,
          caption: 'add the Set to the Objects panel',
        },
        {keys: ['2'], waitMs: 3500, caption: 'Objects: inspect the Set'},
      ],
      quitKeys: ['C-c'],
    },
    args: (ctx) => ['view-heap', '--snapshot', ctx.snapshot('leak', 3)],
  },

  // heap analyses
  {id: 'analyze', args: () => ['analyze']},
  {
    id: 'analyze-detached-DOM',
    args: (ctx) => [
      'analyze',
      'detached-DOM',
      '--snapshot',
      ctx.snapshot('leak', 3),
    ],
  },
  {
    id: 'analyze-global-variable',
    args: (ctx) => [
      'analyze',
      'global-variable',
      '--snapshot',
      ctx.snapshot('leak', 3),
    ],
  },
  {
    id: 'analyze-object',
    args: (ctx) => [
      'analyze',
      'object',
      '--snapshot',
      ctx.snapshot('leak', 3),
      '--node-id',
      ctx.nodeId('leak', 'SettingsDialog'),
    ],
  },
  {
    id: 'analyze-object-fanout',
    args: (ctx) => [
      'analyze',
      'object-fanout',
      '--snapshot',
      ctx.snapshot('leak', 3),
    ],
  },
  {
    id: 'analyze-object-shallow',
    args: (ctx) => [
      'analyze',
      'object-shallow',
      '--snapshot',
      ctx.snapshot('leak', 3),
    ],
  },
  {
    id: 'analyze-object-size',
    args: (ctx) => [
      'analyze',
      'object-size',
      '--snapshot',
      ctx.snapshot('leak', 3),
    ],
  },
  {
    id: 'analyze-shape',
    args: (ctx) => ['analyze', 'shape', '--snapshot', ctx.snapshot('leak', 3)],
  },
  {
    id: 'analyze-string',
    args: (ctx) => ['analyze', 'string', '--snapshot', ctx.snapshot('leak', 3)],
  },
  {
    id: 'analyze-collections-with-stale',
    args: (ctx) => [
      'analyze',
      'collections-with-stale',
      '--snapshot',
      ctx.snapshot('leak', 3),
    ],
  },
  {
    id: 'analyze-unbound-collection',
    args: (ctx) => [
      'analyze',
      'unbound-collection',
      '--snapshot-dir',
      ctx.snapshotDir('series'),
    ],
  },
  {
    id: 'analyze-unbound-object',
    args: (ctx) => [
      'analyze',
      'unbound-object',
      '--snapshot-dir',
      ctx.snapshotDir('series'),
    ],
  },
  {
    id: 'analyze-unbound-shape',
    args: (ctx) => [
      'analyze',
      'unbound-shape',
      '--snapshot-dir',
      ctx.snapshotDir('series'),
    ],
  },

  // utilities
  {id: 'version', args: () => ['version']},
  {id: 'help', args: () => ['help', 'find-leaks']},
  {id: 'list', args: () => ['list']},
  {id: 'get-default-work-dir', args: () => ['get-default-work-dir']},
  {id: 'reset', args: (ctx) => ['reset', '--work-dir', ctx.workDir('reset')]},
];

module.exports = examples;
