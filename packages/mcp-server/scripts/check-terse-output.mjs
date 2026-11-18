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
 * Unit tests for terse-output.ts: the session terse filter and the
 * markdown-to-JSON conversion behind `format: "json"`.
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
const built = path.join(here, '..', 'dist', 'terse-output.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-terse-output: dist/terse-output.js is missing; build first.',
  );
  process.exit(1);
}
const {terseText, markdownToJson, parseCell, compactMarkdownTable} =
  await import(pathToFileURL(built).href);

const note = `_${'An explanation of how to read the table above. '.repeat(3)}_`;
const prose = 'Plain prose that explains the method in detail. '.repeat(5);
const report = [
  '## Report',
  '',
  '| Class | Δ |',
  '|---|--:|',
  '| Object | +42,008 |',
  '',
  note,
  '',
  prose,
  '',
  `**Settle: 10 HELD / 0 DRAINED** (against rung 99). ${'More detail. '.repeat(12)}`,
  '',
  '- `Object` grew by **627 per chats**.',
  '',
  '**Suggested next steps:**',
  '- `memlab_retainer_trace(1)`',
  '',
  '### How to read this',
  '',
  '- a bullet that only explains',
  '',
  '### Kept',
  '',
  '```js',
  'code();',
  '',
  'more();',
  '```',
].join('\n');

test('terseText keeps tables, verdicts and code, drops notes and next steps', () => {
  const out = terseText(report);
  assert.match(out, /\| Object \| \+42,008 \|/);
  assert.match(out, /627 per chats/);
  assert.match(
    out,
    /\*\*Settle: 10 HELD \/ 0 DRAINED\*\* \(against rung 99\)\.$/m,
  );
  assert.doesNotMatch(out, /More detail/);
  assert.doesNotMatch(out, /An explanation/);
  assert.doesNotMatch(out, /Plain prose/);
  assert.doesNotMatch(out, /Suggested next steps|retainer_trace/);
  assert.doesNotMatch(out, /only explains/);
  assert.match(out, /### Kept\n\n```js\ncode\(\);\n\nmore\(\);\n```/);
});

test('terseText leaves an all-prose answer and JSON alone', () => {
  assert.equal(terseText(prose), prose);
  assert.equal(terseText('{"a": 1}'), '{"a": 1}');
});

test('parseCell reads counts and leaves units as text', () => {
  assert.equal(parseCell('369,886'), 369886);
  assert.equal(parseCell('+42,008'), 42008);
  assert.equal(parseCell('-3'), -3);
  assert.equal(parseCell('420.08'), 420.08);
  assert.equal(parseCell('1.2 MB'), '1.2 MB');
  assert.equal(parseCell('**NEW**'), 'NEW');
  assert.equal(parseCell('—'), null);
});

test('markdownToJson splits sections into tables, verdicts and bullets', () => {
  const j = markdownToJson(
    'memlab_leak_report',
    '> Snapshots: 3 rungs\n\n' + report,
  );
  assert.equal(j.source, 'Snapshots: 3 rungs');
  const top = j.sections[0];
  assert.equal(top.heading, 'Report');
  assert.deepEqual(top.tables[0], {
    columns: ['Class', 'Δ'],
    rows: [{Class: 'Object', Δ: 42008}],
  });
  assert.ok(top.verdicts.some(v => v.startsWith('Settle: 10 HELD')));
  assert.ok(top.bullets.includes('Object grew by 627 per chats.'));
  assert.equal(j.sections.at(-1).text[0], '```js\ncode();\n\nmore();\n```');
});

test('markdownToJson reads a CSV-format table and an escaped pipe', () => {
  const j = markdownToJson(
    't',
    '```csv\nName,Count\n"a, b","1,200"\n```\n\n| A | B |\n|---|---|\n| x \\| y | `p|q` |',
  );
  assert.deepEqual(j.sections[0].tables[0].rows[0], {
    Name: 'a, b',
    Count: 1200,
  });
  assert.deepEqual(j.sections[0].tables[1].rows[0], {A: 'x | y', B: 'p|q'});
});

test('compactMarkdownTable drops the padding', () => {
  assert.equal(
    compactMarkdownTable(['a', 'n'], [['x', '1']], new Set([1])),
    '|a|n|\n|---|--:|\n|x|1|',
  );
});
