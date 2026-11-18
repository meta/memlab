/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import vm from 'node:vm';
import {readProbeSets} from './probe-sets.js';

/**
 * One probe as a statement that cannot take the others down: a probe that
 * throws on a rung gets an `error: …` cell, and one that does not parse is
 * reported as such instead of failing the whole program.
 */
function probeStatement(key: string, src: string): string {
  // The inner block lets a probe write `result = …`, `var result` or
  // `let result` alike: each resolves to the variable returned.
  const fn = `(() => { var result; {\n${src}\n; return result; } })`;
  const k = JSON.stringify(key);
  try {
    new vm.Script(fn);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return `__probes[${k}] = ${JSON.stringify(`error: does not parse (${why})`)};`;
  }
  return `try { __probes[${k}] = ${fn}(); } catch (e) { __probes[${k}] = 'error: ' + String((e && e.message) || e).slice(0, 80); }`;
}

/**
 * `use` with no `code`: the sets' probes become the code, one result key per
 * probe, so a saved census runs across a ladder with nothing inline.
 */
export function withProbeSetCode<
  T extends {
    code?: string;
    code_file?: string;
    use?: string[];
    run_dir?: string;
    paths?: string[];
    handles?: string[];
    format?: 'sections' | 'table';
  },
>(raw: T): T {
  const hasCode =
    (raw.code != null && raw.code.trim() !== '') ||
    (raw.code_file != null && raw.code_file !== '');
  if (hasCode || raw.use == null || raw.use.length === 0) return raw;
  const sets = readProbeSets();
  const unknown = raw.use.filter(name => !Object.hasOwn(sets, name));
  if (unknown.length > 0) {
    const known = Object.keys(sets);
    throw new Error(
      `No saved probe set named ${unknown.map(n => `"${n}"`).join(', ')}. ${known.length > 0 ? `Saved: ${known.join(', ')}.` : 'Save one with `memlab_probes({mode: "save", set, name, code})`.'}`,
    );
  }
  // Keyed `<set>/<probe>` when several sets bring probes, so two sets' probes
  // of the same name both get a row.
  const qualify =
    raw.use.filter(name => Object.keys(sets[name].probes).length > 0).length >
    1;
  const probes: Array<[string, string]> = [];
  let runDir: string | undefined;
  for (const name of raw.use) {
    const set = sets[name];
    runDir ??= set.run_dir;
    for (const [probe, spec] of Object.entries(set.probes)) {
      probes.push([qualify ? `${name}/${probe}` : probe, spec.code]);
    }
  }
  if (probes.length === 0) return raw;
  const code = [
    'const __probes = Object.create(null);',
    ...probes.map(([key, src]) => probeStatement(key, src)),
    'result = __probes;',
  ].join('\n');
  const noTarget =
    (raw.run_dir == null || raw.run_dir === '') &&
    (raw.paths == null || raw.paths.length === 0) &&
    (raw.handles == null || raw.handles.length === 0);
  return {
    ...raw,
    code,
    // Only a set's prelude is prepended; a set of probes alone has none.
    use: raw.use.filter(name => (sets[name]?.prelude ?? '').trim() !== ''),
    format: 'table',
    ...(noTarget && runDir != null ? {run_dir: runDir} : {}),
  };
}
