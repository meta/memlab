/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {BaseOption, CLIOptions, CommandOptionExample} from '@memlab/core';

import path from 'path';
import fs from 'fs-extra';
import docUtils from './lib/DocUtils';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import {config, fileManager, utils} from '@memlab/core';
import universalOptions from '../../options/lib/UniversalOptions';

const INDEX_DOC_NAME = 'CLI-commands';
const SIDEBAR_FILE_NAME = 'sidebar.json';
const UNIVERSAL_OPTIONS_ANCHOR = 'universal-options';
// renders the example output with its terminal colors
const TERMINAL_OUTPUT = 'TerminalOutput';
const TERMINAL_OUTPUT_MODULE = '@site/src/components/TerminalOutput';

type SidebarDoc = {
  type: 'doc';
  id: string;
  label: string;
};

type SidebarItem =
  | SidebarDoc
  | {
      type: 'category';
      label: string;
      link: {type: 'doc'; id: string};
      items: SidebarDoc[];
    };

export default class GenerateCLIDocCommand extends BaseCommand {
  private modules: Map<string, BaseCommand> = new Map();
  private universalOptions: BaseOption[] = universalOptions;
  private cliDocsDir = '';
  private examplesDir = '';
  // the directory of the page being written, which its links are relative to
  private pageDir = '';
  // the example output files the current page imports
  private outputImports: string[] = [];

  getCommandName(): string {
    return 'gen-cli-doc';
  }

  getDescription(): string {
    return 'generate CLI markdown documentations';
  }

  isInternalCommand(): boolean {
    return true;
  }

  setModulesMap(modules: Map<string, BaseCommand>) {
    this.modules = modules;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(options: CLIOptions): Promise<void> {
    const docsDir = fileManager.getDocDir();
    this.generateDocs(path.join(docsDir, 'cli'), path.join(docsDir, '_cli'));
  }

  // writes an index page, one page per top-level command, and the sidebar
  // items listing those pages (required by website/sidebars.js); a command
  // with subcommands also gets one page per subcommand in a directory named
  // after it, and a sidebar category; a command page also shows
  // `<examplesDir>/output/<id>.txt` as its example output, played from the
  // recording in `<examplesDir>/replay/<id>.json` if there is one, and
  // `<examplesDir>/<id>.md` as the guide to that output, where `<id>` is the
  // full command with dashes (e.g. `analyze-detached-DOM`); a subcommand's
  // guide is written for its own page (e.g. `../trace.md` links a sibling of
  // its parent)
  generateDocs(cliDocsDir: string, examplesDir: string): void {
    this.cliDocsDir = cliDocsDir;
    this.examplesDir = examplesDir;
    fs.removeSync(cliDocsDir);
    fs.mkdirSync(cliDocsDir, {recursive: true});

    const indexSections: string[] = [];
    const sidebarItems: SidebarItem[] = [];
    const documented = new Set<string>();
    for (const category in CommandCategory) {
      const commands = this.getCommandsInCategory(
        category as CommandCategory,
        documented,
      );
      if (commands.length === 0) {
        continue;
      }
      indexSections.push(
        this.getCategoryIndex(category as CommandCategory, commands),
      );
      for (const command of commands) {
        const name = command.getCommandName();
        documented.add(name);
        const subCommands = this.getPublicSubCommands(command);
        this.writeCommandPage(cliDocsDir, command, subCommands);
        const doc: SidebarDoc = {type: 'doc', id: `cli/${name}`, label: name};
        if (subCommands.length === 0) {
          sidebarItems.push(doc);
          continue;
        }
        const subCommandDir = path.join(cliDocsDir, name);
        fs.mkdirSync(subCommandDir);
        const items = subCommands.map(subCommand => {
          const subName = subCommand.getCommandName();
          this.writeCommandPage(subCommandDir, subCommand, []);
          return {
            type: 'doc' as const,
            id: `cli/${name}/${subName}`,
            label: subName,
          };
        });
        sidebarItems.push({
          type: 'category',
          label: name,
          link: {type: 'doc', id: doc.id},
          items,
        });
      }
    }

    this.writeFile(
      cliDocsDir,
      `${INDEX_DOC_NAME}.md`,
      this.getIndexPage(indexSections),
    );
    this.writeFile(
      cliDocsDir,
      SIDEBAR_FILE_NAME,
      JSON.stringify(sidebarItems, null, 2) + '\n',
    );
  }

  private getCommandsInCategory(
    category: CommandCategory,
    documented: Set<string>,
  ): BaseCommand[] {
    const commands: BaseCommand[] = [];
    for (const command of this.modules.values()) {
      if (category !== command.getCategory()) {
        continue;
      }
      if (command.isInternalCommand() && !config.verbose) {
        continue;
      }
      if (documented.has(command.getCommandName())) {
        continue;
      }
      commands.push(command);
    }
    return commands;
  }

  private getIndexPage(categorySections: string[]): string {
    const universalOptions = this.getOptionList(this.universalOptions);
    return [
      '---',
      'custom_edit_url: null',
      '---',
      '',
      '# Command Line Interface',
      '',
      'Install the memlab command line tool with npm:',
      '',
      '```bash\nnpm install -g memlab\n```',
      '',
      ...categorySections,
      '## Universal Options',
      '',
      'These options work with every command:',
      '',
      universalOptions,
      '',
    ].join('\n');
  }

  private getCategoryIndex(
    category: CommandCategory,
    commands: BaseCommand[],
  ): string {
    const rows = commands.map(command => {
      const name = command.getCommandName();
      // keeps the `#memlab-<name>` anchors of the former single-page docs
      const anchor = `<a id="memlab-${name}"></a>`;
      const link = `[\`memlab ${name}\`](./${name}.md)`;
      return `| ${anchor}${link} | ${this.getSummary(command)} |`;
    });
    return [
      `## ${category.toUpperCase()} Commands`,
      '',
      '| Command | Description |',
      '| --- | --- |',
      ...rows,
      '',
    ].join('\n');
  }

  private getPublicSubCommands(command: BaseCommand): BaseCommand[] {
    return (command.getSubCommands() ?? []).filter(
      subCommand => !subCommand.isInternalCommand(),
    );
  }

  // the path of `target` relative to the page being written, with `/`
  private getRelativePath(target: string): string {
    return path.relative(this.pageDir, target).split(path.sep).join('/') || '.';
  }

  private writeCommandPage(
    dir: string,
    command: BaseCommand,
    subCommands: BaseCommand[],
  ): void {
    this.pageDir = dir;
    this.writeFile(
      dir,
      `${command.getCommandName()}.md`,
      this.getCommandPage(command, subCommands),
    );
  }

  private getCommandPage(
    command: BaseCommand,
    subCommands: BaseCommand[],
  ): string {
    const name = command.getCommandName();
    this.outputImports = [];
    const body = this.getCommandBody(command, subCommands);
    const imports =
      this.outputImports.length === 0
        ? []
        : [
            `import ${TERMINAL_OUTPUT} from '${TERMINAL_OUTPUT_MODULE}';`,
            ...this.outputImports,
            '',
          ];
    return [
      '---',
      `title: memlab ${command.getFullCommand()}`,
      `sidebar_label: ${name}`,
      'custom_edit_url: null',
      '---',
      '',
      ...imports,
      body,
    ].join('\n');
  }

  private getCommandBody(
    command: BaseCommand,
    subCommands: BaseCommand[],
  ): string {
    const name = command.getFullCommand();
    const examplesImportDir = this.getRelativePath(this.examplesDir);
    const lines: string[] = [];
    lines.push(utils.upperCaseFirstCharacter(command.getDescription().trim()));
    lines.push('');
    const cmdDoc = command.getDocumentation().trim();
    if (cmdDoc.length > 0) {
      lines.push(cmdDoc, '');
    }

    const examples = command.getExamples();
    const example: CommandOptionExample = examples[0] ?? '';
    lines.push(
      this.getCodeBlock(docUtils.generateExampleCommand(name, example)),
    );
    lines.push('');

    const exampleBlock = examples
      .slice(1)
      .map(example => docUtils.generateExampleCommand(name, example))
      .join('\n');
    if (exampleBlock.length > 0) {
      lines.push('## Examples', '', this.getCodeBlock(exampleBlock));
      lines.push('');
    }

    const exampleId = name.replace(/ /g, '-');
    const outputFile = `${exampleId}.txt`;
    if (fs.existsSync(path.join(this.examplesDir, 'output', outputFile))) {
      // the page imports the output file as text, so recapturing the examples
      // changes only the output files
      const variable = `${exampleId.replace(/\W/g, '_')}_output`;
      this.outputImports.push(
        `import ${variable} from '!!raw-loader!${examplesImportDir}/output/${outputFile}';`,
      );
      // a recorded terminal session plays as a replay where there is room
      let replayProp = '';
      const replayFile = `${exampleId}.json`;
      if (fs.existsSync(path.join(this.examplesDir, 'replay', replayFile))) {
        const replayVariable = `${exampleId.replace(/\W/g, '_')}_replay`;
        this.outputImports.push(
          `import ${replayVariable} from '${examplesImportDir}/replay/${replayFile}';`,
        );
        replayProp = ` replay={${replayVariable}}`;
      }
      lines.push('## Example output', '');
      lines.push(
        `<${TERMINAL_OUTPUT} output={${variable}}${replayProp} />`,
        '',
      );
    }
    const guide = this.readExample(`${exampleId}.md`);
    if (guide != null) {
      lines.push('## How to read the output', '', guide, '');
    }

    if (subCommands.length > 0) {
      lines.push(this.getSubCommandIndex(command, subCommands), '');
    }

    lines.push('## Options', '');
    const options = this.getCommandOptions(command);
    if (options.length > 0) {
      lines.push(this.getOptionList(options), '');
    }
    lines.push(
      `The [universal options](${this.getRelativePath(this.cliDocsDir)}/${INDEX_DOC_NAME}.md#${UNIVERSAL_OPTIONS_ANCHOR}) ` +
        '(`--help`, `--verbose`, ...) work with this command too.',
    );
    lines.push('');
    return lines.join('\n');
  }

  private getSubCommandIndex(
    command: BaseCommand,
    subCommands: BaseCommand[],
  ): string {
    const name = command.getCommandName();
    const rows = subCommands.map(subCommand => {
      const fullCommand = subCommand.getFullCommand();
      // keeps the `#memlab-<command>-<subcommand>` anchors of the sections
      // that the subcommands had on this page before they got their own pages
      const anchorId = `memlab-${fullCommand.replace(/ /g, '-')}`.toLowerCase();
      const anchor = `<a id="${anchorId}"></a>`;
      const link = `[\`memlab ${fullCommand}\`](./${name}/${subCommand.getCommandName()}.md)`;
      return `| ${anchor}${link} | ${this.getSummary(subCommand)} |`;
    });
    return [
      '## Subcommands',
      '',
      '| Command | Description |',
      '| --- | --- |',
      ...rows,
    ].join('\n');
  }

  private getCommandOptions(command: BaseCommand): BaseOption[] {
    const universal = new Set(
      this.universalOptions.map(option => option.getOptionName()),
    );
    return command
      .getFullOptionsFromPrerequisiteChain()
      .filter(option => !universal.has(option.getOptionName()));
  }

  private getOptionList(options: BaseOption[]): string {
    return options
      .map(option => {
        let header = `**\`--${option.getOptionName()}\`**`;
        if (option.getOptionShortcut()) {
          header += `, **\`-${option.getOptionShortcut()}\`**`;
        }
        return ` * ${header}: ${option.getDescription()}`;
      })
      .join('\n');
  }

  // the first line of the description, safe inside a markdown table cell
  private getSummary(command: BaseCommand): string {
    const desc = utils.upperCaseFirstCharacter(command.getDescription().trim());
    return desc.split('\n')[0].replace(/\|/g, '\\|');
  }

  private getCodeBlock(code: string, codeType = 'bash'): string {
    return '```' + codeType + '\n' + code.replace(/\n+$/, '') + '\n```';
  }

  private readExample(file: string): string | null {
    const filePath = path.join(this.examplesDir, file);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return fs.readFileSync(filePath, 'utf8').trim();
  }

  private writeFile(dir: string, fileName: string, content: string): void {
    fs.writeFileSync(path.join(dir, fileName), content, {encoding: 'utf8'});
  }
}
