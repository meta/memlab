/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

// Records the example terminal output of every CLI command into
// `website/docs/_cli/output/<id>.txt`; `memlab gen-cli-doc` adds it to the
// command's doc page. Run it after `yarn build`, with tmux and a Chromium
// binary available:
//
//   node website/cli-examples/capture.js --chromium-binary <PATH> [--only <ids>]
//
// The commands run in a real terminal (a private tmux server) against the
// example app in `app/`, using a copy of the compiled packages without any
// `fb-internal` directory, so the output is what an npm user sees.
//
// `--only mcp-server` records Claude Code answering a question with the MCP
// server's tools instead. It runs `claude --bare`, which needs `claude` on the
// PATH and an API key (`ANTHROPIC_API_KEY`).

'use strict';

const examples = require('./examples');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const memlabDir = path.join(__dirname, '..', '..');
const outputDir = path.join(__dirname, '..', 'docs', '_cli', 'output');
const replayDir = path.join(__dirname, '..', 'docs', '_cli', 'replay');
const recorder = path.join(__dirname, 'record-pane.js');
const baseDir = path.join(os.tmpdir(), 'memlab-cli-examples');
const packagesCopyDir = path.join(baseDir, '.memlab');
const shownBaseDir = '/tmp/memlab-example';
const shownUrl = 'http://localhost:3000';
const shownPort = new URL(shownUrl).port;
const tmuxSocket = `memlab-cli-examples-${process.pid}`;
const columns = 120;
const rows = 45;
const timeoutMs = 10 * 60 * 1000;

// strings that must not appear in a captured example
const forbiddenPatterns = [
  /fb-internal/i,
  /fbsource/i,
  /internalfb/i,
  /facebook\.net/i,
  /fbinfra/i,
  /thefacebook/i,
  /manifold:\/\//i,
  /devvm/i,
  /\/data\/users\//,
  /www\/scripts\//,
];

function parseArgs(argv) {
  const options = {
    chromiumBinary: process.env.MEMLAB_CHROMIUM_BINARY,
    only: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--chromium-binary') {
      options.chromiumBinary = argv[++i];
    } else if (argv[i] === '--only') {
      options.only = new Set(argv[++i].split(','));
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  if (!options.chromiumBinary) {
    throw new Error(
      'pass --chromium-binary <PATH> or set MEMLAB_CHROMIUM_BINARY',
    );
  }
  return options;
}

// copies the compiled packages, leaving out everything under `fb-internal`
function copyPackages() {
  const packagesDir = path.join(memlabDir, 'packages');
  const modulesDir = path.join(packagesCopyDir, 'node_modules');
  fs.mkdirSync(path.join(modulesDir, '@memlab'), {recursive: true});
  for (const name of fs.readdirSync(packagesDir)) {
    const from = path.join(packagesDir, name);
    const packageJson = path.join(from, 'package.json');
    if (!fs.existsSync(packageJson)) {
      continue;
    }
    const to = path.join(packagesCopyDir, 'packages', name);
    for (const entry of ['package.json', 'bin', 'dist', 'static']) {
      if (!fs.existsSync(path.join(from, entry))) {
        continue;
      }
      fs.cpSync(path.join(from, entry), path.join(to, entry), {
        recursive: true,
        filter: (src) =>
          !src
            .split(path.sep)
            .some((part) =>
              ['fb-internal', 'node_modules', '__tests__'].includes(part),
            ),
      });
    }
    const manifest = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    fs.symlinkSync(to, path.join(modulesDir, manifest.name));
    // ES modules (the MCP server) ignore NODE_PATH, so their dependencies
    // have to be in a node_modules directory above the copy
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const link = path.join(modulesDir, dependency);
      const target = path.join(memlabDir, 'node_modules', dependency);
      if (!dependency.startsWith('@memlab/') && fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(link), {recursive: true});
        if (!fs.existsSync(link)) {
          fs.symlinkSync(target, link);
        }
      }
    }
  }
  // the npm package depends on `puppeteer`; a checkout may only have
  // `puppeteer-core`, which works the same with --chromium-binary
  try {
    require.resolve('puppeteer', {paths: [memlabDir]});
  } catch {
    const core = path.dirname(
      require.resolve('puppeteer-core/package.json', {paths: [memlabDir]}),
    );
    fs.symlinkSync(core, path.join(modulesDir, 'puppeteer'));
  }
}

function startAppServer() {
  const page = path.join(__dirname, 'app', 'index.html');
  const server = http.createServer((req, res) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {'Content-Type': 'text/html'});
    fs.createReadStream(page).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function tmux(args) {
  return childProcess.execFileSync('tmux', ['-u', '-L', tmuxSocket, ...args], {
    encoding: 'utf8',
  });
}

// waits without blocking the event loop, which serves the example app
function waitForSignal(channel) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      'tmux',
      ['-L', tmuxSocket, 'wait-for', channel],
      {timeout: timeoutMs},
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function memlabEnv(url) {
  const modulePaths = [
    path.join(packagesCopyDir, 'node_modules'),
    path.join(memlabDir, 'node_modules'),
  ];
  return {
    ...process.env,
    NODE_PATH: modulePaths.join(path.delimiter),
    MEMLAB_EXAMPLE_URL: `${url}/`,
  };
}

function memlabCommand(args) {
  const bin = path.join(packagesCopyDir, 'packages', 'memlab', 'bin', 'memlab');
  return [
    process.execPath,
    '--expose-gc',
    '--max-old-space-size=4096',
    bin,
    ...args,
  ];
}

function shellQuote(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function createContext(env) {
  const snapshot = (name, n) =>
    path.join(baseDir, name, 'data', 'cur', `s${n}.heapsnapshot`);
  return {
    scenario: (name) => path.join(baseDir, 'scenarios', `${name}.js`),
    workDir: (name) => path.join(baseDir, name),
    snapshotDir: (name) => path.join(baseDir, name, 'data', 'cur'),
    snapshot,
    tmpFile: (name) => path.join(baseDir, 'tmp', name),
    nodeId(name, className) {
      const [node, ...args] = memlabCommand([
        'find-objects',
        '--snapshot',
        snapshot(name, 3),
        '--name-pattern',
        `^${className}$`,
        '--output',
        'json',
      ]);
      const out = childProcess.execFileSync(node, args, {
        env,
        encoding: 'utf8',
      });
      const start = out.indexOf('{');
      if (start < 0) {
        throw new Error(
          `find-objects printed no JSON for ${className} in the ${name} run:\n${out}`,
        );
      }
      const id = JSON.parse(out.slice(start)).objects?.[0]?.id;
      if (id == null) {
        throw new Error(`no ${className} object in the ${name} run`);
      }
      return `@${id}`;
    },
  };
}

// Runs one example in a new tmux window and returns the rendered terminal as
// `screen`. A `tui` example with a `size` gets a session of that size. With
// `replay` steps, the pane is also recorded while the steps run, and the
// recording is returned as `recording`, with the time each step's keys were
// pressed as `keyPresses`.
async function runInTerminal(example, command, env) {
  const {id, tui} = example;
  const script = path.join(baseDir, 'tmp', `${id}.sh`);
  const envExports = ['NODE_PATH', 'MEMLAB_EXAMPLE_URL']
    .map((key) => `export ${key}=${shellQuote(env[key])}`)
    .join('\n');
  fs.writeFileSync(
    script,
    `cd ${shellQuote(baseDir)}\n${envExports}\n` +
      'export LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color\n' +
      // draw boxes with Unicode characters, which the capture keeps
      'export NCURSES_NO_UTF8_ACS=1\n' +
      // print for a plain terminal: blessed wraps some sequences for tmux
      'unset TMUX TMUX_PANE\n' +
      // a recorded example starts once the recorder is attached
      (tui?.replay != null
        ? `tmux -L ${tmuxSocket} wait-for ${id}-start\n`
        : '') +
      `${command.map(shellQuote).join(' ')}\n` +
      `tmux -L ${tmuxSocket} wait-for -S ${id}\n`,
  );
  const done = waitForSignal(id);
  const run = `bash ${shellQuote(script)}`;
  let target = `main:${id}`;
  if (tui?.size != null) {
    target = `${id}:${id}`;
    tmux([
      'new-session',
      '-d',
      '-s',
      id,
      '-n',
      id,
      '-x',
      String(tui.size.columns),
      '-y',
      String(tui.size.rows),
      run,
    ]);
  } else {
    tmux(['new-window', '-d', '-n', id, run]);
  }
  let recording = null;
  const keyPresses = [];
  let screen;
  if (tui != null) {
    if (tui.replay != null) {
      recording = path.join(baseDir, 'tmp', `${id}.replay.json`);
      tmux([
        'pipe-pane',
        '-o',
        '-t',
        target,
        [process.execPath, recorder, recording].map(shellQuote).join(' '),
      ]);
      tmux(['wait-for', '-S', `${id}-start`]);
    }
    await sleep(tui.waitMs);
    if (tui.input != null) {
      tmux(['send-keys', '-t', target, '-l', tui.input]);
      tmux(['send-keys', '-t', target, 'Enter']);
      await sleep(tui.afterInputMs);
    }
    screen = keepColors(tmux(['capture-pane', '-p', '-e', '-t', target]));
    // each step waits like a person reading the screen before the next one
    await (tui.replay ?? []).reduce(
      (previous, step) =>
        previous.then(() => {
          keyPresses.push({time: Date.now(), step});
          tmux(['send-keys', '-t', target, ...step.keys]);
          return sleep(step.waitMs);
        }),
      Promise.resolve(),
    );
    if (recording != null) {
      // closing the pipe makes the recorder write the recording
      tmux(['pipe-pane', '-t', target]);
      await waitForFile(recording);
    }
    tmux(['send-keys', '-t', target, ...tui.quitKeys]);
  }
  await done;
  if (screen == null) {
    screen = keepColors(
      tmux([
        'capture-pane',
        '-p',
        '-e',
        '-J',
        '-S',
        '-',
        '-E',
        '-',
        '-t',
        target,
      ]),
      {chart: true},
    );
  }
  tmux(['kill-window', '-t', target]);
  return {screen, recording, keyPresses};
}

// replay timing of an assistant session: the prompt is typed, the answer
// appears a line at a time, and every wait for the model or a tool is capped
const PROMPT_TYPING_MS = 15;
const ANSWER_MS_PER_CHAR = 4;
const MODEL_WAIT_MS = 1200;
const TOOL_WAIT_MS = 2000;
// lines of a tool result shown under its call
const RESULT_LINES = 4;

// Runs `claude` on the example's prompt with only the MCP server's tools and
// returns each message it prints, with the time it was printed. `--bare`
// leaves out the user's hooks, plugins and CLAUDE.md files.
function runClaude(example, ctx) {
  const {assistant, id} = example;
  assistant.prepare?.(ctx);
  // the server keeps its state files here instead of in the home directory
  const home = path.join(baseDir, 'tmp', `${id}-home`);
  fs.mkdirSync(home, {recursive: true});
  const server = path.join(
    packagesCopyDir,
    'packages',
    'mcp-server',
    'dist',
    'index.js',
  );
  const mcpConfig = path.join(baseDir, 'tmp', `${id}-mcp.json`);
  fs.writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        memlab: {
          type: 'stdio',
          command: process.execPath,
          args: ['--max-old-space-size=8192', server],
          env: {HOME: home, MEMLAB_STATE_DIR: home},
        },
      },
    }),
  );
  const style =
    `Your answer is shown in a ${assistant.size.columns - 2}-column ` +
    'terminal: use short paragraphs and lists, no tables or headings, and ' +
    'keep it under 25 lines. Show a retainer trace in a code block, one ' +
    'reference per line, with every step and edge name exactly as a tool ' +
    'printed it, from the root to the leaked object. Pass file paths ' +
    'relative to the current directory.';
  const args = [
    '-p',
    '--bare',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--tools',
    '',
    '--allowedTools',
    'mcp__memlab',
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    style,
    assistant.prompt,
  ];
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn('claude', args, {
      cwd: assistant.cwd(ctx),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    const messages = [];
    let pending = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      for (const line of lines.filter((l) => l.trim() !== '')) {
        messages.push({time: Date.now(), message: JSON.parse(line)});
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(messages);
      } else {
        reject(new Error(`claude exited with ${code}:\n${stderr}`));
      }
    });
  });
}

// the terminal on the doc page has no emoji, and draws each one as a box
const EMOJI = /\p{Extended_Pictographic}\uFE0F?\s?/gu;

function styled(runs) {
  return runs
    .map(({codes, text}) =>
      codes === '' ? text : `\x1b[${codes}m${text}\x1b[0m`,
    )
    .join('');
}

// splits a line of Markdown into runs of text with their color codes: bold
// for **bold** and cyan for `code`
function markdownRuns(line) {
  const runs = [];
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    runs.push({text: line.slice(last, match.index), codes: ''});
    runs.push(
      match[1] != null
        ? {text: match[1].replace(/`/g, ''), codes: '1'}
        : {text: match[2], codes: '36'},
    );
    last = match.index + match[0].length;
  }
  runs.push({text: line.slice(last), codes: ''});
  return runs.filter((run) => run.text !== '');
}

// wraps runs of text at spaces into lines of at most `width` characters; the
// lines after the first start with `indent` spaces
function wrapRuns(runs, width, indent) {
  const lines = [[]];
  let length = 0;
  let lineStart = 0;
  const push = (run) => {
    lines[lines.length - 1].push(run);
    length += run.text.length;
  };
  const newLine = () => {
    const line = lines[lines.length - 1];
    while (line.length > 0 && /^ +$/.test(line[line.length - 1].text)) {
      line.pop();
    }
    lines.push([{text: ' '.repeat(indent), codes: ''}]);
    length = indent;
    lineStart = indent;
  };
  const tokens = runs.flatMap((run) =>
    run.text
      .split(/( +)/)
      .filter((text) => text !== '')
      .map((text) => ({text, codes: run.codes})),
  );
  for (const token of tokens) {
    if (/^ +$/.test(token.text)) {
      if (length > lineStart) {
        push({text: token.text, codes: ''});
      }
      continue;
    }
    let {text} = token;
    if (length + text.length > width && length > lineStart) {
      newLine();
    }
    while (length + text.length > width) {
      const room = width - length;
      push({text: text.slice(0, room), codes: token.codes});
      text = text.slice(room);
      newLine();
    }
    push({text, codes: token.codes});
  }
  return lines.map(styled);
}

// the lines of an assistant message, after a `● ` marker
function textLines(text, width) {
  const lines = [];
  let inCode = false;
  for (const line of text.replace(EMOJI, '').trim().split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      lines.push(styled([{text: truncate(line, width - 2), codes: '36'}]));
      continue;
    }
    const heading = /^#+\s+/.exec(line);
    if (heading != null) {
      lines.push(styled([{text: line.slice(heading[0].length), codes: '1'}]));
      continue;
    }
    const lead = /^\s*/.exec(line)[0].length;
    const item = /^(?:[-*]|\d+\.)\s+/.exec(line.slice(lead));
    const wrapped = wrapRuns(
      markdownRuns(line.slice(lead)),
      width - 2 - lead,
      item?.[0].length ?? 0,
    );
    lines.push(...wrapped.map((wrappedLine) => ' '.repeat(lead) + wrappedLine));
  }
  return lines.map((line, i) => (i === 0 ? `● ${line}` : `  ${line}`));
}

function truncate(text, width) {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

// a tool call, as Claude Code shows it, with paths relative to `cwd`
function toolCallLine(block, width, cwd) {
  const name = block.name.replace(/^mcp__memlab__/, '');
  const args = Object.entries(block.input)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(', ')
    .split(`${cwd}/`)
    .join('')
    .split(JSON.stringify(cwd))
    .join('"."');
  const call = truncate(`${name} (MCP)(${args})`, width - 11);
  return `${styled([{text: '●', codes: '32'}])} memlab - ${styled([
    {text: call.slice(0, name.length), codes: '1'},
  ])}${call.slice(name.length)}`;
}

// the retainer path in a tool result's JSON, if it has one
function retainerPath(text) {
  try {
    const {path: steps} = JSON.parse(text);
    return Array.isArray(steps) && steps.every((step) => step.name != null)
      ? steps
      : null;
  } catch {
    return null;
  }
}

// a retainer path one reference per line, the way memlab prints a trace
function retainerPathLines(steps, width) {
  return steps.map((step, i) => {
    const node = truncate(`${step.name} (${step.type})`, width - 7);
    if (i === 0) {
      return `  ⎿  ${node}`;
    }
    const edge = styled([{text: `--${steps[i - 1].edge}-->`, codes: '2'}]);
    return `       ${edge} ${node}`;
  });
}

// the first lines of a tool result, leaving out rules, tables and blank lines
// (tables are too wide to show cut, and their emoji don't render)
function toolResultLines(block, width) {
  const text = Array.isArray(block.content)
    ? block.content.map((part) => part.text ?? '').join('\n')
    : String(block.content);
  const steps = retainerPath(text);
  if (steps != null) {
    return retainerPathLines(steps, width);
  }
  const lines = text
    .split('\n')
    .map((line) =>
      line
        .replace(EMOJI, '')
        .replace(/\*\*/g, '')
        .replace(/^#+\s+/, '')
        .replace(/^_(.*)_$/, '$1')
        .trimEnd(),
    )
    .filter(
      (line) =>
        line.trim() !== '' && !/^(=+ .* =+|-{3,}|> Snapshots?: .*)$/.test(line),
    );
  const shown = lines
    .filter((line) => !line.startsWith('|'))
    .slice(0, RESULT_LINES)
    .map((line) => truncate(line, width - 5));
  const hidden = lines.length - shown.length;
  if (hidden > 0) {
    shown.push(`… +${hidden} lines`);
  }
  const codes = block.is_error ? '31' : '2';
  return shown.map(
    (line, i) =>
      `${i === 0 ? '  ⎿  ' : '     '}${styled([{text: line, codes}])}`,
  );
}

// Turns the messages of a `claude` run into the screen it would leave and a
// recording of it appearing: the prompt is typed, then each answer, tool
// call and tool result appears after the time it took, capped.
function renderAssistant(prompt, messages, size, cwd) {
  const width = size.columns;
  const screen = [];
  const events = [];
  let time = 0;
  const write = (content) => events.push({time, content});
  const promptLines = wrapRuns([{text: prompt, codes: ''}], width - 2, 0);
  promptLines.forEach((line, i) => {
    write(i === 0 ? `${styled([{text: '>', codes: '2'}])} ` : '  ');
    for (const char of line) {
      time += PROMPT_TYPING_MS;
      write(char);
    }
    write('\r\n');
  });
  screen.push(
    ...promptLines.map((line, i) =>
      i === 0 ? `${styled([{text: '>', codes: '2'}])} ${line}` : `  ${line}`,
    ),
  );
  const addLines = (lines, msPerChar = 0) => {
    screen.push(...lines);
    for (const line of lines) {
      time += stripColors(line).length * msPerChar;
      write(`${line}\r\n`);
    }
  };
  // a blank line goes before each answer and tool call, not before a result
  const addBlock = (lines, msPerChar) => {
    screen.push('');
    write('\r\n');
    addLines(lines, msPerChar);
  };
  let previous = messages[0]?.time ?? 0;
  for (const {message, time: at} of messages) {
    const content = message.message?.content;
    if (
      !['assistant', 'user'].includes(message.type) ||
      !Array.isArray(content)
    ) {
      continue;
    }
    const cap = message.type === 'user' ? TOOL_WAIT_MS : MODEL_WAIT_MS;
    time += Math.min(at - previous, cap);
    previous = at;
    for (const block of content) {
      if (block.type === 'text' && block.text.trim() !== '') {
        addBlock(textLines(block.text, width), ANSWER_MS_PER_CHAR);
      } else if (block.type === 'tool_use') {
        addBlock([toolCallLine(block, width, cwd)]);
      } else if (block.type === 'tool_result') {
        addLines(toolResultLines(block, width));
      }
    }
  }
  return {screen: screen.join('\n'), recording: {start: 0, events}};
}

async function runAssistant(example, ctx) {
  const {assistant} = example;
  const messages = await runClaude(example, ctx);
  const {recording, screen} = renderAssistant(
    assistant.prompt,
    messages,
    assistant.size,
    assistant.cwd(ctx),
  );
  fs.writeFileSync(
    path.join(baseDir, 'tmp', `${example.id}.messages.json`),
    JSON.stringify(messages),
  );
  const file = path.join(baseDir, 'tmp', `${example.id}.replay.json`);
  fs.writeFileSync(file, JSON.stringify(recording));
  return {screen, recording: file};
}

function waitForFile(file, deadline = Date.now() + 10000) {
  if (fs.existsSync(file)) {
    return Promise.resolve();
  }
  if (Date.now() > deadline) {
    return Promise.reject(new Error(`the recorder did not write ${file}`));
  }
  return sleep(100).then(() => waitForFile(file, deadline));
}

const COLOR_CODE = /\x1b\[([0-9;]*)m/;
const ANY_COLOR_CODE = /\x1b\[[0-9;]*m/g;

function stripColors(text) {
  return text.replace(ANY_COLOR_CODE, '');
}

// Rewrites the colors tmux captured into a small, stable form: only the
// foreground color, bold, and dim are kept, each run of text gets its own code
// followed by a reset, and every line ends uncolored. With `chart`, the memory
// chart is drawn the way a terminal shows it: its bars are reverse-video
// spaces (drawn as blocks) and its grid is underscores in black (dropped).
function keepColors(text, {chart = false} = {}) {
  let color = null;
  let bold = false;
  let dim = false;
  let reverse = false;
  let lineRuns = [];
  const lines = [];
  const codes = () =>
    [bold && '1', dim && '2', color].filter(Boolean).join(';');
  const addText = (part) => {
    const pieces = part.split('\n');
    pieces.forEach((piece, i) => {
      if (i > 0) {
        lines.push(lineRuns);
        lineRuns = [];
      }
      let runText = piece;
      if (chart && reverse) {
        runText = runText.replace(/ /g, '\u2588');
      }
      if (chart && color === '30') {
        runText = runText.replace(/_/g, ' ');
      }
      if (runText !== '') {
        lineRuns.push({
          text: runText,
          codes: /^\s*$/.test(runText) ? '' : codes(),
        });
      }
    });
  };
  text.split(COLOR_CODE).forEach((part, i) => {
    if (i % 2 === 0) {
      addText(part);
      return;
    }
    for (const code of part.split(';')) {
      if (code === '' || code === '0') {
        color = null;
        bold = false;
        dim = false;
        reverse = false;
      } else if (code === '1') {
        bold = true;
      } else if (code === '2') {
        dim = true;
      } else if (code === '22') {
        bold = false;
        dim = false;
      } else if (code === '7') {
        reverse = true;
      } else if (code === '27') {
        reverse = false;
      } else if (code === '39') {
        color = null;
      } else if (/^(3[0-7]|9[0-7])$/.test(code)) {
        color = code;
      }
    }
  });
  lines.push(lineRuns);
  return lines
    .map((runs) => {
      // merge neighbors with the same codes, then drop trailing spaces
      const merged = [];
      for (const run of runs) {
        const last = merged[merged.length - 1];
        if (last != null && last.codes === run.codes) {
          last.text += run.text;
        } else {
          merged.push({...run});
        }
      }
      while (merged.length > 0) {
        const last = merged[merged.length - 1];
        last.text = last.text.replace(/\s+$/, '');
        if (last.text !== '') {
          break;
        }
        merged.pop();
      }
      return merged
        .map((run) =>
          run.codes === '' ? run.text : `\x1b[${run.codes}m${run.text}\x1b[0m`,
        )
        .join('');
    })
    .join('\n');
}

// replaces the paths and the port that differ between machines and runs
function replaceLocalDetails(text, url) {
  const {port} = new URL(url);
  return (
    text
      .split(fs.realpathSync(baseDir))
      .join(shownBaseDir)
      .split(baseDir)
      .join(shownBaseDir)
      .split(url)
      .join(shownUrl)
      // the port also shows without the URL around it, and a panel too narrow
      // for the whole URL shows only its start
      .replace(/localhost:(\d+)(?!\d)/g, (match, digits) => {
        if (digits === port) {
          return `localhost:${shownPort}`;
        }
        return port.startsWith(digits)
          ? `localhost:${shownPort.slice(0, digits.length)}`
          : match;
      })
      .split(os.homedir())
      .join('~')
  );
}

function normalize(text, url) {
  const result = replaceLocalDetails(text, url)
    .split('\n')
    .filter((line) => !/^Pane is dead \(/.test(stripColors(line)))
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return result.trim() + '\n';
}

// escape sequences: CSI (cursor moves, colors, modes), OSC (window title),
// character set selection, and single-character controls
const ESCAPE_SEQUENCE =
  /\x1b\[[0-9;?>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMc]/g;

function stripEscapes(text) {
  return text.replace(ESCAPE_SEQUENCE, '');
}

const TYPING_MS = 45;
const ENTER_MS = 600;
// writes closer together than this are played as one
const FRAME_MS = 30;
// the snapshot loads before the screen opens; that part plays this much faster
const LOADING_SPEEDUP = 4;
const MAX_PAUSE_MS = 2000;

// how the keys sent with `tmux send-keys` are shown on the doc page
const KEY_LABELS = {Down: '↓', Up: '↑', Left: '←', Right: '→', Escape: 'Esc'};

// Turns a pane recording into the replay played on the doc page: the command
// is typed after a `$ ` prompt, then the command's output plays with its own
// timing, except that loading plays faster and long pauses are shortened.
// Each key press is a `{time, key, caption}` event in the replay. A recording
// without a `shownCommand` (an assistant session) shows its own prompt, and
// has no loading to speed up.
function buildReplay(recorded, keyPresses, shownCommand, url, size) {
  const events = [];
  let time = 300;
  if (shownCommand != null) {
    events.push({time, content: '$ '});
    const typed = replaceLocalDetails(shownCommand, url).replace(/^\$ /, '');
    for (const char of typed) {
      time += TYPING_MS;
      events.push({time, content: char});
    }
    time += ENTER_MS;
    events.push({time, content: '\r\n'});
  }
  const presses = keyPresses.map(({step, time: pressedAt}) => ({
    time: pressedAt - recorded.start,
    key: step.keys.map((key) => KEY_LABELS[key] ?? key).join(' '),
    caption: step.caption,
  }));
  const recordedEvents = [...recorded.events, ...presses].sort(
    (a, b) => a.time - b.time,
  );
  let previous = 0;
  let loading = shownCommand != null;
  for (const {time: at, ...event} of recordedEvents) {
    let gap = at - previous;
    previous = at;
    if (loading) {
      gap /= LOADING_SPEEDUP;
    }
    // the screen opens by switching to the alternate screen buffer
    if (event.content?.includes('\x1b[?1049h')) {
      loading = false;
    }
    time += Math.min(Math.round(gap), MAX_PAUSE_MS);
    const last = events[events.length - 1];
    if (
      event.content != null &&
      last?.content != null &&
      last.content !== '\r\n' &&
      time - last.time < FRAME_MS
    ) {
      last.content += event.content;
    } else {
      events.push({time, ...event});
    }
  }
  return {
    columns: size.columns,
    rows: size.rows,
    events: events.map((e) =>
      e.content == null
        ? e
        : {time: e.time, content: replaceLocalDetails(e.content, url)},
    ),
  };
}

// one event per line, so that a recapture shows up as a readable diff
function formatReplay(replay) {
  const events = replay.events.map((e) => `    ${JSON.stringify(e)}`);
  return (
    `{\n  "columns": ${replay.columns},\n  "rows": ${replay.rows},\n` +
    `  "events": [\n${events.join(',\n')}\n  ]\n}\n`
  );
}

function findForbidden(text) {
  const patterns = [
    ...forbiddenPatterns,
    new RegExp(`\\b${os.hostname().replace(/\./g, '\\.')}\\b`, 'i'),
    new RegExp(`\\b${os.hostname().split('.')[0]}\\b`, 'i'),
    new RegExp(`\\b${os.userInfo().username}\\b`),
    new RegExp(memlabDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  ];
  return stripColors(text)
    .split('\n')
    .filter((line) => patterns.some((pattern) => pattern.test(line)));
}

// Writes an example's output and, if it was recorded, its replay, after
// checking that neither shows internal details. A command example's output
// starts with its `shownCommand`; an assistant session's starts with its
// prompt.
function writeExample(example, result, url, failures) {
  const {keyPresses = [], recording, screen, shownCommand = null} = result;
  const output = normalize(
    shownCommand == null ? screen : `${shownCommand}\n${screen}`,
    url,
  );
  const forbidden = findForbidden(output);
  if (forbidden.length > 0) {
    failures.push(
      `${example.id}: internal details in the output:\n  ${forbidden.join('\n  ')}`,
    );
    return;
  }
  fs.writeFileSync(path.join(outputDir, `${example.id}.txt`), output);
  if (recording == null) {
    return;
  }
  const size = example.assistant?.size ?? example.tui.size;
  const replay = buildReplay(
    JSON.parse(fs.readFileSync(recording, 'utf8')),
    keyPresses,
    shownCommand,
    url,
    size,
  );
  const played = stripEscapes(
    replay.events.map((e) => e.content ?? e.caption ?? '').join(''),
  );
  const leaked = findForbidden(played);
  if (played.includes(baseDir)) {
    leaked.push(baseDir);
  }
  if (leaked.length > 0) {
    failures.push(
      `${example.id}: internal details in the replay:\n  ${leaked.join('\n  ')}`,
    );
    return;
  }
  fs.mkdirSync(replayDir, {recursive: true});
  fs.writeFileSync(
    path.join(replayDir, `${example.id}.json`),
    formatReplay(replay),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.rmSync(baseDir, {recursive: true, force: true});
  fs.mkdirSync(path.join(baseDir, 'tmp'), {recursive: true});
  fs.cpSync(
    path.join(__dirname, 'scenarios'),
    path.join(baseDir, 'scenarios'),
    {
      recursive: true,
    },
  );
  fs.mkdirSync(outputDir, {recursive: true});
  copyPackages();

  const server = await startAppServer();
  const url = `http://localhost:${server.address().port}`;
  const env = memlabEnv(url);
  const ctx = createContext(env);
  tmux([
    '-f',
    '/dev/null',
    'new-session',
    '-d',
    '-s',
    'main',
    '-x',
    String(columns),
    '-y',
    String(rows),
  ]);
  tmux(['set-option', '-g', 'history-limit', '100000']);
  tmux(['set-option', '-g', 'remain-on-exit', 'on']);

  const failures = [];
  try {
    for (const example of examples) {
      const selected = options.only == null || options.only.has(example.id);
      if (!selected && !example.setup && !example.required) {
        continue;
      }
      // an assistant session runs `claude`, so it has to be asked for
      if (example.assistant != null && options.only?.has(example.id) !== true) {
        continue;
      }
      const args = example.assistant == null ? example.args(ctx) : null;
      const browserArgs = example.browser
        ? ['--chromium-binary', options.chromiumBinary]
        : [];
      console.log(
        `${example.setup ? 'setting up' : 'capturing'} ${example.id}`,
      );
      if (typeof example.tui?.input === 'function') {
        example.tui = {...example.tui, input: example.tui.input(ctx)};
      }
      // the examples share one tmux server and later ones read earlier output
      // eslint-disable-next-line no-await-in-loop
      const {keyPresses, recording, screen} = await (args == null
        ? runAssistant(example, ctx)
        : runInTerminal(
            example,
            memlabCommand([...args, ...browserArgs]),
            env,
          ));
      if (example.setup || !selected) {
        continue;
      }
      const shownCommand =
        args == null ? null : `$ memlab ${args.map(shellQuote).join(' ')}`;
      writeExample(
        example,
        {screen, recording, keyPresses, shownCommand},
        url,
        failures,
      );
    }
  } finally {
    tmux(['kill-server']);
    server.close();
  }
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log(`example output written to ${outputDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
