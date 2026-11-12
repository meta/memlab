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
// command and waiting `afterInputMs`), then `quitKeys` are sent.

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
    tui: {waitMs: 15000, quitKeys: ['C-c']},
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
