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

'use strict';

const examples = require('./examples');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const memlabDir = path.join(__dirname, '..', '..');
const outputDir = path.join(__dirname, '..', 'docs', '_cli', 'output');
const baseDir = path.join(os.tmpdir(), 'memlab-cli-examples');
const packagesCopyDir = path.join(baseDir, '.memlab');
const shownBaseDir = '/tmp/memlab-example';
const shownUrl = 'http://localhost:3000';
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
    const packageName = JSON.parse(fs.readFileSync(packageJson, 'utf8')).name;
    fs.symlinkSync(to, path.join(modulesDir, packageName));
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
      const json = JSON.parse(out.slice(out.indexOf('{')));
      const id = json.objects?.[0]?.id;
      if (id == null) {
        throw new Error(`no ${className} object in the ${name} run`);
      }
      return `@${id}`;
    },
  };
}

// runs one example in a new tmux window and returns the rendered terminal
async function runInTerminal(example, command, env) {
  const script = path.join(baseDir, 'tmp', `${example.id}.sh`);
  const envExports = ['NODE_PATH', 'MEMLAB_EXAMPLE_URL']
    .map((key) => `export ${key}=${shellQuote(env[key])}`)
    .join('\n');
  fs.writeFileSync(
    script,
    `cd ${shellQuote(baseDir)}\n${envExports}\n` +
      'export LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color\n' +
      // draw boxes with Unicode characters, which the capture keeps
      'export NCURSES_NO_UTF8_ACS=1\n' +
      `${command.map(shellQuote).join(' ')}\n` +
      `tmux -L ${tmuxSocket} wait-for -S ${example.id}\n`,
  );
  const done = waitForSignal(example.id);
  tmux(['new-window', '-d', '-n', example.id, `bash ${shellQuote(script)}`]);
  const target = `main:${example.id}`;
  let screen;
  if (example.tui != null) {
    await sleep(example.tui.waitMs);
    if (example.tui.input != null) {
      tmux(['send-keys', '-t', target, '-l', example.tui.input]);
      tmux(['send-keys', '-t', target, 'Enter']);
      await sleep(example.tui.afterInputMs);
    }
    screen = tmux(['capture-pane', '-p', '-t', target]);
    tmux(['send-keys', '-t', target, ...example.tui.quitKeys]);
  }
  await done;
  if (screen == null) {
    screen = renderColors(
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
    );
  }
  tmux(['kill-window', '-t', target]);
  return screen;
}

// drops the terminal colors, keeping what they draw: the memory chart's bars
// are reverse-video spaces, and its grid is underscores in black
function renderColors(text) {
  let reverse = false;
  let black = false;
  return text
    .split(/(\x1b\[[0-9;]*m)/)
    .map((part, i) => {
      if (i % 2 === 1) {
        for (const code of part.slice(2, -1).split(';')) {
          if (code === '' || code === '0') {
            reverse = false;
            black = false;
          } else if (code === '7') {
            reverse = true;
          } else if (code === '27') {
            reverse = false;
          } else if (/^(3[0-9]|9[0-7])$/.test(code)) {
            black = code === '30';
          }
        }
        return '';
      }
      const text = reverse ? part.replace(/ /g, '\u2588') : part;
      return black ? text.replace(/_/g, ' ') : text;
    })
    .join('');
}

function normalize(text, url) {
  const realBaseDir = fs.realpathSync(baseDir);
  let result = text
    .split(realBaseDir)
    .join(shownBaseDir)
    .split(baseDir)
    .join(shownBaseDir)
    .split(url)
    .join(shownUrl)
    .split(os.homedir())
    .join('~');
  result = result
    .split('\n')
    .filter((line) => !/^Pane is dead \(/.test(line))
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return result.trim() + '\n';
}

function findForbidden(text) {
  const patterns = [
    ...forbiddenPatterns,
    new RegExp(`\\b${os.hostname().replace(/\./g, '\\.')}\\b`, 'i'),
    new RegExp(`\\b${os.hostname().split('.')[0]}\\b`, 'i'),
    new RegExp(`\\b${os.userInfo().username}\\b`),
    new RegExp(memlabDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  ];
  return text
    .split('\n')
    .filter((line) => patterns.some((pattern) => pattern.test(line)));
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
      const args = example.args(ctx);
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
      const screen = await runInTerminal(
        example,
        memlabCommand([...args, ...browserArgs]),
        env,
      );
      if (example.setup || !selected) {
        continue;
      }
      const shownCommand = `$ memlab ${args.map(shellQuote).join(' ')}`;
      const output = normalize(`${shownCommand}\n${screen}`, url);
      const forbidden = findForbidden(output);
      if (forbidden.length > 0) {
        failures.push(
          `${example.id}: internal details in the output:\n  ${forbidden.join('\n  ')}`,
        );
        continue;
      }
      fs.writeFileSync(path.join(outputDir, `${example.id}.txt`), output);
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
