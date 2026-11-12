/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {BaseOption} from '@memlab/core';

import fs from 'fs';
import os from 'os';
import path from 'path';
import {config} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../../../BaseCommand';
import GenerateCLIDocCommand from '../../../commands/helper/GenerateCLIDocCommand';
import SnapshotFileOption from '../../../options/heap/SnapshotFileOption';
import HelperOption from '../../../options/HelperOption';

class SubCommand extends BaseCommand {
  getCommandName(): string {
    return 'sub';
  }
  getDescription(): string {
    return 'run the sub analysis';
  }
}

class ParentCommand extends BaseCommand {
  getCommandName(): string {
    return 'parent';
  }
  getDescription(): string {
    return 'parent command | with a pipe\nand a second line';
  }
  getCategory(): CommandCategory {
    return CommandCategory.COMMON;
  }
  getExamples(): string[] {
    return ['--snapshot <FILE>', '--snapshot /tmp/s.heapsnapshot'];
  }
  getOptions(): BaseOption[] {
    return [new SnapshotFileOption(), new HelperOption()];
  }
  getSubCommands(): BaseCommand[] {
    const sub = new SubCommand();
    sub.setParentCommand(this);
    return [sub];
  }
}

class MiscCommand extends BaseCommand {
  getCommandName(): string {
    return 'misc';
  }
  getDescription(): string {
    return 'do something else';
  }
}

class InternalCommand extends BaseCommand {
  getCommandName(): string {
    return 'internal';
  }
  getDescription(): string {
    return 'internal only';
  }
  isInternalCommand(): boolean {
    return true;
  }
}

let docDir = '';

beforeEach(() => {
  config.isTest = true;
  config.verbose = false;
  docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlab-cli-doc-'));
  const modules = new Map<string, BaseCommand>();
  for (const command of [
    new MiscCommand(),
    new InternalCommand(),
    new ParentCommand(),
  ]) {
    modules.set(command.getCommandName(), command);
  }
  const examplesDir = path.join(docDir, '_cli');
  fs.mkdirSync(path.join(examplesDir, 'output'), {recursive: true});
  fs.writeFileSync(
    path.join(examplesDir, 'output', 'parent.txt'),
    '$ memlab parent --snapshot s.heapsnapshot\nfound 1 object\n',
  );
  fs.writeFileSync(
    path.join(examplesDir, 'parent.md'),
    'Each row is a class.\n',
  );
  fs.writeFileSync(
    path.join(examplesDir, 'output', 'parent-sub.txt'),
    '$ memlab parent sub\n',
  );
  const generator = new GenerateCLIDocCommand();
  generator.setModulesMap(modules);
  generator.generateDocs(path.join(docDir, 'cli'), examplesDir);
});

afterEach(() => {
  fs.rmSync(docDir, {recursive: true, force: true});
});

function read(file: string): string {
  return fs.readFileSync(path.join(docDir, 'cli', file), 'utf8');
}

test('writes an index, one page per public command, and the sidebar', () => {
  expect(fs.readdirSync(path.join(docDir, 'cli')).sort()).toEqual([
    'CLI-commands.md',
    'misc.md',
    'parent.md',
    'sidebar.json',
  ]);
  // commands are ordered by category: COMMON before MISC
  expect(JSON.parse(read('sidebar.json'))).toEqual([
    {type: 'doc', id: 'cli/parent', label: 'parent'},
    {type: 'doc', id: 'cli/misc', label: 'misc'},
  ]);
});

test('the index links each command and keeps the old anchors', () => {
  const index = read('CLI-commands.md');
  expect(index).toContain(
    '| <a id="memlab-parent"></a>[`memlab parent`](./parent.md) | ' +
      'Parent command \\| with a pipe |',
  );
  expect(index).toContain('## Universal Options');
  expect(index).toContain(' * **`--help`**, **`-h`**: print helper text');
  expect(index).not.toContain('internal');
});

test('a command page lists its own options and its subcommands', () => {
  const page = read('parent.md');
  expect(page).toMatch(/^---\ntitle: memlab parent\nsidebar_label: parent\n/);
  expect(page).toContain(
    '```bash\nmemlab parent --snapshot /tmp/s.heapsnapshot\n```',
  );
  expect(page).toContain(' * **`--snapshot`**: ');
  // universal options are linked, not repeated
  expect(page).not.toContain('**`--help`**');
  expect(page).toContain('./CLI-commands.md#universal-options');
  expect(page).toContain('## memlab parent sub\n\nRun the sub analysis');
  expect(page).toContain('### Options');
});

test('a command page shows its example output and how to read it', () => {
  const page = read('parent.md');
  // the page imports the output file as text and renders it with its colors
  expect(page).toContain(
    "---\n\nimport TerminalOutput from '@site/src/components/TerminalOutput';\n" +
      "import parent_output from '!!raw-loader!../_cli/output/parent.txt';\n",
  );
  expect(page).toContain(
    '## Example output\n\n<TerminalOutput output={parent_output} />\n',
  );
  expect(page).toContain('## How to read the output\n\nEach row is a class.');
  // subcommands look up `<parent>-<sub>` one heading level deeper
  expect(page).toContain(
    "import parent_sub_output from '!!raw-loader!../_cli/output/parent-sub.txt';",
  );
  expect(page).toContain(
    '### Example output\n\n<TerminalOutput output={parent_sub_output} />',
  );
  expect(page.split('import TerminalOutput').length).toBe(2);
  // sections appear only when their file exists
  expect(read('misc.md')).not.toContain('Example output');
  expect(read('misc.md')).not.toContain('import TerminalOutput');
  expect(page.indexOf('## How to read the output')).toBeLessThan(
    page.indexOf('## Options'),
  );
});
