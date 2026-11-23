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
 * Unit tests for memlab_coverage_check (tools/coverage-check.ts) and the
 * lead registry it reads (lead-registry.ts): draft parsing, matching a lead
 * to a finding or not_problem, and lead bookkeeping.
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
const tool = path.join(dist, 'tools', 'coverage-check.js');
if (!fs.existsSync(tool)) {
  console.error(
    'check-coverage-check: dist/tools/coverage-check.js is missing; build first.',
  );
  process.exit(1);
}
const {
  parseDraft,
  leadTerms,
  itemFor,
  isQuestionable,
  checkCall,
  coverageReport,
  dedupe,
} = await import(pathToFileURL(tool).href);
const {recordLead, recordSweepLeads, allLeads, clearLeads} = await import(
  pathToFileURL(path.join(dist, 'lead-registry.js')).href
);

const lead = over => ({
  label: '-',
  ids: [],
  bytes: 100_000,
  kind: 'large',
  why: 'top retained',
  source: 'test',
  snapshot: 's1',
  ...over,
});

const report = JSON.stringify({
  findings: [
    {
      id: 'F1',
      summary: 'HQ thumbnails on Msg models (__x_thumbnailHQ), @4242.',
    },
    {id: 'F2', summary: 'The module timing map grows'},
  ],
  not_problems: [
    {
      summary: 'ErrorUtils.history (51 entries)',
      reason: 'It is capped: flat in s1/s2/s3.',
    },
    {summary: 'RelayAsyncStreamPool', reason: 'Only 11 streams.'},
  ],
});

test('report.json splits into findings and not_problems', () => {
  const items = parseDraft(report);
  assert.deepEqual(
    items.map(i => [i.kind, i.label]),
    [
      ['finding', 'F1'],
      ['finding', 'F2'],
      ['not_problem', 'NP1'],
      ['not_problem', 'NP2'],
    ],
  );
});

test('markdown: items under a not-problems heading are not_problems', () => {
  const md =
    '# Report\n## F1 Thumbnails\ntext\n## Not problems\n- modulesTimeMap: bounded\n- other\n## Appendix\nx\n';
  const kinds = parseDraft(md).map(
    i => `${i.kind}:${i.text.trim().split('\n')[0]}`,
  );
  assert.deepEqual(kinds, [
    'finding:# Report',
    'finding:## F1 Thumbnails',
    'not_problem:## Not problems',
    'not_problem:- modulesTimeMap: bounded',
    'not_problem:- other',
    'finding:## Appendix',
  ]);
});

test('terms: camelCase suffixes, stop words and weak words', () => {
  const t = leadTerms(
    lead({label: 'Object.WAWebAnimatedEmojiAssetLoader', name: 'Object'}),
  );
  assert.ok(t.strong.includes('AssetLoader'));
  assert.ok(t.strong.includes('EmojiAssetLoader'));
  assert.ok(!t.strong.includes('Loader'));
  assert.ok(!t.strong.includes('Object'));
  // Two camel parts give no shorter variant: `Interaction` alone is generic.
  assert.deepEqual(
    leadTerms(lead({label: 'closure var tracedInteraction'})).strong,
    ['tracedInteraction'],
  );
  const h = leadTerms(
    lead({label: 'Object.history (+1)', path: 'global:ErrorUtils.history'}),
  );
  assert.deepEqual(h.strong, ['ErrorUtils']);
  assert.deepEqual(h.weak, ['history']);
  assert.deepEqual(
    leadTerms(lead({label: 'strings Object.__ref', edge: 'Object.__ref'}))
      .strong,
    ['__ref'],
  );
});

test('a lead matches a finding by id or name, else a not_problem, else nothing', () => {
  const items = parseDraft(report);
  assert.equal(itemFor(lead({ids: [4242]}), items).label, 'F1');
  assert.equal(
    itemFor(lead({label: 'Msg.__x_thumbnailHQ'}), items).label,
    'F1',
  );
  const np = itemFor(
    lead({label: 'Object.history', path: 'global:ErrorUtils.history'}),
    items,
  );
  assert.equal(np.label, 'NP1');
  assert.equal(
    itemFor(lead({label: 'RelayAsyncStreamPool.$2 ▸ entry'}), items).label,
    'NP2',
  );
  assert.equal(
    itemFor(lead({label: 'Object.WAWebAnimatedEmojiAssetLoader'}), items),
    null,
  );
  // `__ref` is a word: `__refs` does not name it.
  assert.equal(
    itemFor(lead({label: 'Object.__ref'}), parseDraft('uses __refs')),
    null,
  );
  // A short id is not matched: 42 appears in any number.
  assert.equal(itemFor(lead({ids: [42]}), parseDraft('42 entries')), null);
});

test('questionable: a soft reason against dead/duplicate/finished/growing evidence', () => {
  const [, , np1, np2] = parseDraft(report);
  assert.equal(isQuestionable(lead({kind: 'growing'}), np1), true);
  assert.equal(isQuestionable(lead({kind: 'large'}), np1), false);
  assert.equal(isQuestionable(lead({kind: 'dead'}), np2), false);
});

test('check calls per lead kind', () => {
  assert.equal(
    checkCall(lead({ids: [7]}), false),
    'memlab_retainer_trace({node_id:7})',
  );
  assert.equal(
    checkCall(lead({ids: [7], kind: 'dead'}), true),
    'memlab_what_if({node_ids:[7], snapshot:"s1"})',
  );
  assert.match(
    checkCall(lead({edge: 'Object.__ref'}), false),
    /memlab_residual\(\{explained:\[\{"label":"x","edge":"Object.__ref"\}\]\}\)/,
  );
});

test('registry: one node keeps its strongest evidence and largest bytes', () => {
  clearLeads();
  recordLead(null, {
    label: 'A.x',
    ids: [9],
    bytes: 10,
    kind: 'large',
    why: 'big',
    source: 'a',
  });
  recordLead(null, {
    label: 'A.x',
    ids: [9],
    bytes: 5,
    kind: 'dead',
    why: '90% dead',
    source: 'b',
  });
  recordLead(null, {
    label: 'A.x',
    ids: [9],
    bytes: 1,
    kind: 'residual',
    why: 'left',
    source: 'a',
  });
  const all = allLeads();
  assert.equal(all.length, 1);
  assert.equal(all[0].kind, 'dead');
  assert.equal(all[0].why, '90% dead');
  assert.equal(all[0].bytes, 10);
  assert.equal(all[0].source, 'a+b');
});

test('sweep leads map sections to kinds', () => {
  clearLeads();
  const fake = {getNodeById: () => null};
  recordSweepLeads(fake, [
    {label: 'Object.beforeunload', bytes: 4e5, ids: [1001], section: 2},
    {
      label: 'per-call keys: modulesTimeMap',
      bytes: 3e6,
      ids: [1002],
      section: 4,
    },
    {
      label: 'cancelled scheduler tasks: x',
      bytes: 6e4,
      ids: [1003],
      section: 4,
    },
    {
      label: 'strings Object.__ref',
      bytes: 1e6,
      edge: 'Object.__ref',
      section: 3,
    },
  ]);
  assert.deepEqual(
    allLeads().map(l => [l.label, l.kind]),
    [
      ['Object.beforeunload', 'dead'],
      ['per-call keys: modulesTimeMap', 'growing'],
      ['cancelled scheduler tasks: x', 'dead'],
      ['strings Object.__ref', 'duplicate'],
    ],
  );
});

test('new sweep sections map to kinds; growth and async keep theirs', () => {
  clearLeads();
  const fake = {getNodeById: () => null};
  recordSweepLeads(fake, [
    {label: 'error history: x', bytes: 5, ids: [2001], section: 5},
    {label: 'trace finished', bytes: 5, ids: [2002], section: 6},
    {label: 'Unit cleanup el', bytes: 5, ids: [2003], section: 7},
    {label: 'React list: Feed', bytes: 0, ids: [2004], section: 8},
    {label: 'async flag', bytes: 5, ids: [2005], section: 10},
    {label: 'grew', bytes: 5, ids: [2006], section: 11},
  ]);
  assert.deepEqual(
    allLeads().map(l => l.kind),
    ['large', 'finished', 'dead', 'large', 'finished', 'growing'],
  );
});

test('a snapshot whose book was evicted or cleared gets a new book', () => {
  clearLeads();
  const snaps = Array.from({length: 17}, () => ({getNodeById: () => null}));
  snaps.forEach((s, i) =>
    recordLead(s, {kind: 'large', why: 'w', source: 't', ids: [i + 1]}),
  );
  // 16 books are kept: the first snapshot's book is gone.
  assert.equal(allLeads().length, 16);
  recordLead(snaps[0], {kind: 'large', why: 'w', source: 't', ids: [99]});
  assert.ok(allLeads().some(l => l.ids[0] === 99));
  clearLeads();
  recordLead(snaps[1], {kind: 'large', why: 'w', source: 't', ids: [98]});
  assert.deepEqual(
    allLeads().map(l => l.ids[0]),
    [98],
  );
});

test('dedupe does not write into the registry leads', () => {
  clearLeads();
  const s1 = {getNodeById: () => null};
  const s2 = {getNodeById: () => null};
  const l = {
    kind: 'large',
    why: 'w',
    source: 't',
    path: 'module:WebLoom.pendingTraces',
  };
  recordLead(s1, {...l, ids: [1], bytes: 10});
  recordLead(s2, {...l, ids: [2], bytes: 5});
  for (let i = 0; i < 3; i++) {
    const rows = dedupe(allLeads());
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].ids, [1, 2]);
  }
  assert.deepEqual(
    allLeads().map(x => x.ids),
    [[1], [2]],
  );
});

test('report: uncovered sorted by bytes, unnamed on one line, ⚠ on soft not_problems', () => {
  const leads = [
    lead({
      label: 'Object.WAWebAnimatedEmojiAssetLoader',
      ids: [586779],
      bytes: 1.3e6,
    }),
    lead({label: 'closure var tracedInteraction', ids: [514937], bytes: 7e5}),
    lead({label: 'closure (anonymous)', ids: [1501647], bytes: 1.2e6}),
    lead({
      label: 'Object.history',
      path: 'global:ErrorUtils.history',
      kind: 'growing',
      bytes: 4e5,
    }),
    lead({label: 'Msg.__x_thumbnailHQ', ids: [4242], bytes: 1.6e7}),
    lead({label: 'Object.tinyThing', ids: [5], bytes: 100}),
  ];
  const md = coverageReport(leads, parseDraft(report), 64 * 1024, 20);
  assert.match(md, /3 of 5 leads/);
  assert.ok(md.indexOf('AssetLoader') < md.indexOf('tracedInteraction'));
  assert.match(md, /no holder name.*@1501647/);
  assert.match(md, /\| ⚠ \|.*ErrorUtils|⚠.*Object\.history/);
  assert.match(md, /Covered by findings \(1\): F1: Msg.__x_thumbnailHQ/);
  assert.doesNotMatch(md, /tinyThing/);
});

test('markdown: items under an Ignored heading account for a lead', () => {
  const items = parseDraft(
    '# Findings\n## F1 the queue\n\n## Ignored\n- ignored: dispatcherFunc records, instrumentation is off in production\n',
  );
  const ignored = items.find(i => /ignored: dispatcherFunc/.test(i.text));
  assert.equal(ignored?.kind, 'not_problem');
  const shape = lead({
    label: 'a{dispatcherFunc, implementation, interceptor, name}',
    kind: 'large',
    ids: [537369],
  });
  assert.equal(itemFor(shape, items)?.kind, 'not_problem');
});

test('bottom-up leads: a shape that grew by count is listed with its check', () => {
  const grew = lead({
    label: 't{context, eventType, key, listener, remove, subscriber}',
    ids: [8661577],
    kind: 'growing',
    bytes: 2_100_000,
    why: 'shape grew 10,574 → 72,361 instances',
    check:
      'memlab_population_diff({population:"shape:context,eventType,key,listener,remove,subscriber"})',
  });
  const out = coverageReport(
    [grew],
    parseDraft('# Findings\n## F1 other\n'),
    64 * 1024,
    5,
  );
  assert.match(out, /with a signal/);
  assert.match(out, /memlab_population_diff/);
});
