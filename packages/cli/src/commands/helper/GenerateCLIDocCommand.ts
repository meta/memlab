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

type SidebarItem = {
  type: 'doc';
  id: string;
  label: string;
};

export default class GenerateCLIDocCommand extends BaseCommand {
  private modules: Map<string, BaseCommand> = new Map();
  private universalOptions: BaseOption[] = universalOptions;
  private examplesDir = '';
  // the example output files the current page imports
  private outputImports: string[] = [];
  private outputImportDir = '';

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
  // page also shows `<examplesDir>/output/<id>.txt` as its example output and
  // `<examplesDir>/<id>.md` as the guide to that output, where `<id>` is the
  // full command with dashes (e.g. `analyze-detached-DOM`)
  generateDocs(cliDocsDir: string, examplesDir: string): void {
    this.examplesDir = examplesDir;
    this.outputImportDir = path
      .relative(cliDocsDir, path.join(examplesDir, 'output'))
      .split(path.sep)
      .join('/');
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
        this.writeFile(cliDocsDir, `${name}.md`, this.getCommandPage(command));
        sidebarItems.push({type: 'doc', id: `cli/${name}`, label: name});
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

  private getCommandPage(command: BaseCommand): string {
    const name = command.getCommandName();
    this.outputImports = [];
    const body = this.getCommandBody(command, '##');
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
      `title: memlab ${name}`,
      `sidebar_label: ${name}`,
      'custom_edit_url: null',
      '---',
      '',
      ...imports,
      body,
    ].join('\n');
  }

  private getCommandBody(command: BaseCommand, headingLevel: string): string {
    const name = command.getFullCommand();
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
      lines.push(
        `${headingLevel} Examples`,
        '',
        this.getCodeBlock(exampleBlock),
      );
      lines.push('');
    }

    const exampleId = name.replace(/ /g, '-');
    const outputFile = `${exampleId}.txt`;
    if (fs.existsSync(path.join(this.examplesDir, 'output', outputFile))) {
      // the page imports the output file as text, so recapturing the examples
      // changes only the output files
      const variable = `${exampleId.replace(/\W/g, '_')}_output`;
      this.outputImports.push(
        `import ${variable} from '!!raw-loader!${this.outputImportDir}/${outputFile}';`,
      );
      lines.push(`${headingLevel} Example output`, '');
      lines.push(`<${TERMINAL_OUTPUT} output={${variable}} />`, '');
    }
    const guide = this.readExample(`${exampleId}.md`);
    if (guide != null) {
      lines.push(`${headingLevel} How to read the output`, '', guide, '');
    }

    lines.push(`${headingLevel} Options`, '');
    const options = this.getCommandOptions(command);
    if (options.length > 0) {
      lines.push(this.getOptionList(options), '');
    }
    lines.push(
      `The [universal options](./${INDEX_DOC_NAME}.md#${UNIVERSAL_OPTIONS_ANCHOR}) ` +
        '(`--help`, `--verbose`, ...) work with this command too.',
    );
    lines.push('');

    for (const subCommand of command.getSubCommands() ?? []) {
      if (subCommand.isInternalCommand()) {
        continue;
      }
      lines.push(`${headingLevel} memlab ${subCommand.getFullCommand()}`, '');
      lines.push(this.getCommandBody(subCommand, headingLevel + '#'));
    }
    return lines.join('\n');
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
