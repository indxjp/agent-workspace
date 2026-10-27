#!/usr/bin/env node
/* global console, setTimeout, URL */
/**
 * The ten use cases of the landing page (`tests/gallery/<id>/`), run with the published `aw`,
 * `@indx-workspace/sdk` and `@indx-workspace/embedded` (what `npm create` pins) from a real
 * registry and the real model (issue #881, the `install-live` workflow). For each project: its own
 * MCP servers and stand-in APIs (the `#   ...` lines of its `agent-workspace.yaml`), then `aw dev`
 * until it is ready, signed in and has made its first sync, the folders its agents are granted
 * (`aw files mkdir`, then `aw files upload` of `data/<folder>/`), `aw push --yes`, `aw check`, one
 * `aw chat -p` turn with the first prompt of its eval file, `aw eval --json`, and Ctrl+C. A shared
 * skill an agent names is copied into the project's `skills/` first.
 *
 *   ANTHROPIC_API_KEY=... node tests/docs-claims/use-cases.mjs [--version <v>] [--registry <url>]
 *
 * Rows have the claims runner's format and exit code: without `ANTHROPIC_API_KEY` every row of a
 * project is `skipped`, which is red, never a pass. A project passes `aw eval` when the command
 * exits 0. `$DOCS_CLAIMS_WORK_DIR` (default: a temporary directory) gets `summary.md`,
 * `results.json` and one scrubbed log per project under `logs/`, ending with the `aw dev` output
 * after the ready screen (`== aw dev, after the ready screen`).
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { positiveIntegerVariable } from '../generated-project/run.mjs';
import { JourneyFailure, registryOf, workDirectoryOf } from '../journey/harness.mjs';
import { SECRETS, say, scrub } from '../journey/run.mjs';
import { createHostMachine } from './host.mjs';
import { exitCodeOf, summaryMarkdown } from './run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NEEDS_KEY = 'skipped: needs ANTHROPIC_API_KEY (not configured)';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const DEV_READY_MS = 3 * 60_000;

/** The projects of the landing page's use-case list, in its order. */
export const PROJECTS = [
  'manual-search',
  'cad-drafting',
  'contract-review',
  'customer-inquiry',
  'excel-consolidation',
  'maintenance-troubleshooting',
  'meeting-minutes',
  'quality-defect',
  'quotation',
  'ringi-review',
];

/** @typedef {import('./run.mjs').Row} Row */

/** A stand-in for a company's HTTP API behind an `openapiTool()`, as opposed to an MCP server. */
export const STAND_IN = /(?:^|\/)fake-[^/]+\.mjs$/u;

const ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=(\S*)\s*/u;
const PLACEHOLDER = /^(?:\.\.\.|…)$/u;

/**
 * The indented `#   ...` lines of a project file: the commands its comments tell you to run.
 *
 * @param {string} projectYaml
 */
const commentCommands = (projectYaml) =>
  projectYaml
    .replace(/ \\\n#\s+/gu, ' ')
    .split('\n')
    .flatMap((line) => {
      const command = /^#\s{3,}(\S.*)$/u.exec(line)?.[1];
      return command === undefined ? [] : [command];
    });

/**
 * @param {string} line a command line that may start with `NAME=value` words
 * @param {() => string} secret a value for the placeholders `...` and `…`
 * @returns {{ env: Record<string, string>, rest: string }}
 */
function leadingEnvironment(line, secret) {
  /** @type {Record<string, string>} */
  const env = {};
  let rest = line;
  for (let match = ASSIGNMENT.exec(rest); match !== null; match = ASSIGNMENT.exec(rest)) {
    env[match[1] ?? ''] = PLACEHOLDER.test(match[2] ?? '') ? secret() : (match[2] ?? '');
    rest = rest.slice(match[0].length);
  }
  return { env, rest };
}

/**
 * The MCP servers a project file says to run: `NAME=value ... node <script>.mjs`, with a placeholder
 * value replaced by `secret()` and a variable in `overrides` by its value there.
 *
 * @param {string} projectYaml @param {() => string} secret
 * @param {Readonly<Record<string, string>>} [overrides]
 * @returns {{ env: Record<string, string>, script: string, port: number }[]}
 */
export function serverCommands(projectYaml, secret, overrides = {}) {
  return commentCommands(projectYaml).flatMap((line) => {
    const { env, rest } = leadingEnvironment(line, secret);
    const script = /^node (\S+\.mjs)$/u.exec(rest)?.[1];
    if (script === undefined) return [];
    for (const name of Object.keys(env)) if (name in overrides) env[name] = overrides[name] ?? '';
    return [{ env, script, port: Number(env['PORT']) }];
  });
}

/**
 * The environment a project file says `aw dev` needs: `NAME=value ... aw dev`.
 *
 * @param {string} projectYaml @param {() => string} secret
 * @returns {Record<string, string>}
 */
export function devEnvironment(projectYaml, secret) {
  return Object.assign(
    {},
    ...commentCommands(projectYaml).flatMap((line) => {
      const { env, rest } = leadingEnvironment(line, secret);
      return rest === 'aw dev' ? [env] : [];
    }),
  );
}

/**
 * The `input:` of the first case of an eval file, plain or as a `|` / `>` block.
 *
 * @param {string} evalYaml
 * @returns {string | undefined}
 */
export function firstPrompt(evalYaml) {
  const lines = evalYaml.split('\n');
  const at = lines.findIndex((line) => /^ {4}input:/u.test(line));
  if (at < 0) return undefined;
  const value = (lines[at] ?? '').replace(/^ {4}input:\s*/u, '');
  if (!/^[|>][+-]?$/u.test(value))
    return value.replace(/^(["'])(.*)\1$/u, '$2').trim() || undefined;
  const block = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && !line.startsWith('      ')) break;
    block.push(line.slice(6));
  }
  const text = block.join('\n').trim();
  return text === '' ? undefined : text;
}

/** @returns {string} the checked-out commit (hash and subject), or `unknown` when git cannot say */
function checkoutCommit() {
  try {
    return execFileSync('git', ['log', '-1', '--format=%h %s'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .replaceAll('`', "'");
  } catch {
    return 'unknown';
  }
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The most runs traced per project: each trace may take `commandMs`, inside the step's budget. */
export const MAX_TRACED_RUNS = 5;

/**
 * The cases of an `aw eval --json` output that failed after a run started, with the run to trace,
 * at most `MAX_TRACED_RUNS` of them (the eval output in the log names every failed case).
 * Output that is not an evaluation (or a list of them) gives none: the caller is already failing.
 * When the whole output is not JSON, it is parsed from the first line that starts with `{` or `[`
 * and parses, so earlier lines (progress notices, even bracketed ones) are ignored.
 *
 * @param {string} evalStdout
 * @returns {{ name: string, runId: string, failures: string[] }[]}
 */
export function failedRuns(evalStdout) {
  let parsed;
  try {
    parsed = JSON.parse(evalStdout);
  } catch {
    for (const match of evalStdout.matchAll(/^[{[]/gmu)) {
      try {
        parsed = JSON.parse(evalStdout.slice(match.index));
        break;
      } catch {
        // a bracketed progress line; try the next candidate
      }
    }
    if (parsed === undefined) return [];
  }
  const found = [];
  for (const evaluation of Array.isArray(parsed) ? parsed : [parsed]) {
    const results = evaluation?.results;
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      if (result?.passed !== false || typeof result.runId !== 'string') continue;
      if (!RUN_ID.test(result.runId)) continue;
      const failures = Array.isArray(result.failures)
        ? result.failures.filter((failure) => typeof failure === 'string')
        : [];
      found.push({ name: String(result.name), runId: result.runId, failures });
    }
  }
  return found.slice(0, MAX_TRACED_RUNS);
}

/**
 * The run a failed `aw chat -p` names (`error: run_failed: run <uuid> failed: …`), for the caller to
 * trace. Undefined when the output names none, or an id that is not a UUID (it is put in a command).
 *
 * @param {string} chatOutput
 * @returns {string | undefined}
 */
export function chatFailedRunId(chatOutput) {
  const id = /\brun (\S+) failed\b/u.exec(chatOutput)?.[1];
  return id !== undefined && RUN_ID.test(id) ? id : undefined;
}

/** @param {string} dir a project directory @returns {string[]} the source of each `agents/*.ts` */
const agentSources = (dir) =>
  readdirSync(path.join(dir, 'agents'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(path.join(dir, 'agents', name), 'utf8'));

/** @param {string} text */
const quoted = (text) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * The commands that put a project's files where its agents expect them, as its project file and
 * its tutorial tell a user: for each `files('<folder>')` grant, `aw files mkdir <folder>`, then
 * `aw files upload` every file of `data/<folder>/` when the project ships one. Since #899 an upload
 * creates its folder, so the tutorials drop the mkdir for those; this harness keeps it because it
 * also runs against a published release that predates the fix, where a grant resolves against a
 * folder row only `mkdir` creates. The workspace is fresh, so the folder never exists yet.
 *
 * @param {string} dir a project directory
 * @returns {string[]}
 */
export function fileSetupCommands(dir) {
  const folders = new Set(
    agentSources(dir).flatMap((source) =>
      [...source.matchAll(/\bfiles\(\s*['"]([^'"]+)['"]/gu)].map((match) => match[1] ?? ''),
    ),
  );
  return [...folders].flatMap((folder) => {
    const data = path.join(dir, 'data', folder);
    const uploads = existsSync(data)
      ? readdirSync(data, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) =>
            path.relative(data, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/'),
          )
          .sort()
          .map(
            (name) =>
              `aw files upload ${quoted(`${folder}/${name}`)} ${quoted(`data/${folder}/${name}`)}`,
          )
      : [];
    return [`aw files mkdir ${quoted(folder)}`, ...uploads];
  });
}

/**
 * Point the OpenAPI documents of a project (`apis/*.openapi.json`) at a stand-in API on loopback,
 * keeping each document's base path: their `servers` name the company's own host, which cannot be
 * resolved here, and a user trying the project edits the same line.
 *
 * @param {string} dir a project directory @param {number} port
 */
export function pointApisAtLoopback(dir, port) {
  const apis = path.join(dir, 'apis');
  if (!existsSync(apis)) return;
  for (const name of readdirSync(apis).filter((file) => file.endsWith('.openapi.json'))) {
    const file = path.join(apis, name);
    const document = JSON.parse(readFileSync(file, 'utf8'));
    const [server] = document.servers ?? [];
    const base = new URL(server?.url ?? 'http://api.invalid/').pathname.replace(/\/$/u, '');
    document.servers = [{ url: `http://127.0.0.1:${String(port)}${base}` }];
    writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  }
}

/** @param {number} port @param {number} timeoutMs */
async function listening(port, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const up = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (up) return;
    if (Date.now() > until) throw new JourneyFailure(`nothing listens on port ${String(port)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Start one MCP server in its own process group, with no model key in its environment.
 *
 * @param {string} cwd @param {{ env: Record<string, string>, script: string, port: number }} server
 */
async function startServer(cwd, server) {
  const child = spawn(process.execPath, [server.script], {
    cwd,
    env: { ...process.env, ...server.env },
    detached: true,
    stdio: 'ignore',
  });
  const stop = () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  };
  try {
    await listening(server.port, 30_000);
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}

/**
 * @param {ReturnType<typeof createHostMachine>} machine
 * @param {string} id @param {string} dir the project's copy @param {string} logs
 * @param {{ secret: () => string, apiKey: string }} how
 * @returns {Promise<Row[]>}
 */
async function projectRows(machine, id, dir, logs, how) {
  const where = `tests/gallery/${id}`;
  const steps = [
    'MCP servers',
    'aw dev',
    'aw files',
    'aw push',
    'aw check',
    'aw chat -p',
    'aw eval',
  ];
  /** @param {string} result @param {string} [detail] */
  const all = (result, detail) =>
    steps.map((what) => ({ where, state: 'run', what, result, detail }));
  if (how.apiKey === '') return all(NEEDS_KEY);

  const projectYaml = readFileSync(path.join(dir, 'agent-workspace.yaml'), 'utf8');
  const prompt = firstPrompt(readFileSync(path.join(dir, 'evals', `${id}.yaml`), 'utf8'));
  if (prompt === undefined) return all('FAIL: no case in the eval file', `${id}: evals/${id}.yaml`);
  const stops = [];
  let log = '';
  /** @type {Row[]} */
  const rows = [];
  /** @type {ReturnType<typeof machine.startDev> | undefined} */
  let dev;
  let readyLength = 0;
  let traces = '';
  /**
   * @param {string} what @param {() => Promise<string>} body its output; throws when it fails
   */
  const step = async (what, body) => {
    if (rows.some((row) => row.result.startsWith('FAIL'))) {
      rows.push({ where, state: 'run', what, result: 'skipped: an earlier step failed' });
      return;
    }
    const started = performance.now();
    try {
      log += `== ${what}\n${scrub(await body())}\n`;
      rows.push({
        where,
        state: 'run',
        what,
        result: 'pass',
        seconds: (performance.now() - started) / 1000,
      });
    } catch (error) {
      const message = scrub(error instanceof Error ? error.message : String(error));
      log += `== ${what}\n${message}\n`;
      rows.push({
        where,
        state: 'run',
        what,
        result: 'FAIL: not what the use case promises',
        seconds: (performance.now() - started) / 1000,
        detail: message,
      });
    }
  };
  /**
   * @param {string} command @param {Record<string, string>} [env] @param {number} [times]
   * @param {boolean} [allowFailure] return a non-zero exit instead of throwing it
   */
  const aw = async (command, env = {}, times = 1, allowFailure = false) => {
    const result = await machine.exec(command, {
      cwd: dir,
      env,
      timeoutMs: machine.commandMs * times,
    });
    if (result.status !== 0 && !allowFailure) {
      throw new JourneyFailure(`${command} exited ${String(result.status)}\n${result.output}`);
    }
    return result;
  };
  /** @param {string} heading @param {string} runId append the trace of a run to the log */
  const traceRun = async (heading, runId) => {
    traces += `== trace: ${heading}\n`;
    try {
      const trace = await aw(`aw runs trace ${runId}`, {}, 1, true);
      traces +=
        trace.status === 0
          ? `${trace.output}\n`
          : `the trace could not be loaded: aw runs trace exited ${String(trace.status)}\n${trace.output}\n`;
    } catch (error) {
      traces += `the trace could not be loaded: ${error instanceof Error ? error.message : String(error)}\n`;
    }
  };
  try {
    const secret = how.secret;
    const dataRoot = path.join(dir, 'data');
    const devEnv = devEnvironment(projectYaml, secret);
    await step('MCP servers', async () => {
      // A secret both `aw dev` and a server are given is one value, as the project file says.
      for (const server of serverCommands(projectYaml, secret, {
        FILE_ROOT: dataRoot,
        ...devEnv,
      })) {
        stops.push(await startServer(dir, server));
        if (STAND_IN.test(server.script)) pointApisAtLoopback(dir, server.port);
      }
      return '';
    });
    await step('aw dev', async () => {
      dev = machine.startDev(dir, devEnv);
      await dev.untilWidget(DEV_READY_MS);
      // The ready screen, with its `widget:` line, comes before the first sync; a check made
      // before that sync ends sees a workspace without the project's skills and tools.
      await dev.until(
        (current) => current.syncs > 0 || /^sync: /mu.test(current.log),
        () => 'synced:',
        DEV_READY_MS,
      );
      readyLength = dev.state.log.length;
      return dev.state.log;
    });
    await step('aw files', async () => {
      const commands = fileSetupCommands(dir);
      if (commands.length === 0) return 'no files to upload';
      return (await aw(commands.join(' && '), {}, commands.length)).output;
    });
    await step('aw push', async () => (await aw('aw push --yes', devEnv)).output);
    await step('aw check', async () => (await aw('aw check')).output);
    await step('aw chat -p', async () => {
      const command = `aw chat ${id} -p "$AW_PROMPT"`;
      const reply = await aw(command, { AW_PROMPT: prompt }, 1, true);
      if (reply.status !== 0) {
        const runId = chatFailedRunId(reply.output);
        if (runId !== undefined) await traceRun(`aw chat -p (${runId})`, runId);
        throw new JourneyFailure(`${command} exited ${String(reply.status)}\n${reply.output}`);
      }
      if (reply.stdout.trim() === '') throw new JourneyFailure('aw chat printed no answer');
      return reply.output;
    });
    await step('aw eval', async () => {
      // A failed suite still prints its results: the run of each failed case is traced below.
      const command = `aw eval ${id} --json`;
      const result = await aw(command, {}, 3, true);
      if (result.status === 0) return result.stdout;
      for (const { name, runId, failures } of failedRuns(result.stdout)) {
        await traceRun(`${name} (${runId}) ${failures.join(' | ')}`, runId);
      }
      throw new JourneyFailure(`${command} exited ${String(result.status)}\n${result.output}`);
    });
  } finally {
    if (dev !== undefined) {
      const running = dev;
      try {
        await running.stop((capMs) => capMs);
      } catch (error) {
        const started = rows.find((row) => row.what === 'aw dev');
        if (started !== undefined && started.result === 'pass') {
          started.result = 'FAIL: aw dev did not stop on Ctrl+C';
          started.detail = scrub(error instanceof Error ? error.message : String(error));
        }
        running.kill();
      }
      // The trace of each failed eval case, from aw runs trace.
      if (traces !== '') log += scrub(traces);
      // The server's side of every run after the ready screen: why a run failed is logged here.
      log += `== aw dev, after the ready screen\n${scrub(running.state.log.slice(readyLength))}\n`;
    }
    for (const stop of stops) stop();
    writeFileSync(path.join(logs, `${id}.log`), log);
  }
  return rows;
}

/** The engine every gallery agent runs on. */
const GALLERY_ENGINE = 'claude-agent-sdk';

/**
 * The installs of a real user's project: `aw` globally, then the SDK and the embedded
 * runtime (which `aw dev` refuses to start without) in `gallery/`, the parent every project finds,
 * then the packages of the engine the gallery agents use, at the versions the installed SDK pins
 * (the runtime carries no engine of its own, ADR-0139).
 *
 * @param {string} version
 * @returns {readonly (readonly [what: string, command: string])[]}
 */
export function installSteps(version) {
  return [
    [
      'npm install --global @indx-workspace/aw',
      `npm install --global '@indx-workspace/aw@${version}'`,
    ],
    [
      'npm install @indx-workspace/sdk @indx-workspace/embedded',
      `npm install --no-audit --no-fund '@indx-workspace/sdk@${version}' '@indx-workspace/embedded@${version}'`,
    ],
    [
      `npm install ${GALLERY_ENGINE} packages`,
      `pkgs="$(node -e "import('@indx-workspace/sdk/project').then((m) => console.log(Object.entries(m.ENGINE_PACKAGES['${GALLERY_ENGINE}']).map(([n, v]) => n + '@' + v).join(' ')))")" && npm install --no-audit --no-fund $pkgs`,
    ],
  ];
}

/** @param {readonly string[]} argv */
export function parseArguments(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { version: { type: 'string' }, registry: { type: 'string' } },
      strict: true,
    }));
  } catch (error) {
    throw new JourneyFailure(
      `usage: node tests/docs-claims/use-cases.mjs [--version <v>] [--registry <url>] (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const version = values.version ?? 'latest';
  if (!/^[A-Za-z0-9._-]+$/u.test(version)) {
    throw new JourneyFailure(`--version is a version or a dist-tag, not "${version}"`);
  }
  return { version, registry: registryOf(values.registry) ?? DEFAULT_REGISTRY };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const apiKey = process.env['ANTHROPIC_API_KEY']?.trim() ?? '';
  if (apiKey !== '') SECRETS.add(apiKey);
  delete process.env['ANTHROPIC_API_KEY'];
  const work = path.resolve(
    workDirectoryOf(process.env['DOCS_CLAIMS_WORK_DIR']) ??
      mkdtempSync(path.join(tmpdir(), 'use-cases-')),
  );
  const logs = path.join(work, 'logs');
  mkdirSync(logs, { recursive: true });
  const commandMs = positiveIntegerVariable('DOCS_CLAIMS_COMMAND_TIMEOUT_MS', 5 * 60_000);
  const machine = createHostMachine({
    shell: 'sh',
    work,
    registry: options.registry,
    env: apiKey === '' ? { CI: 'true' } : { CI: 'true', ANTHROPIC_API_KEY: apiKey },
    commandMs,
    logs,
  });
  const secret = () => {
    const value = randomBytes(16).toString('hex');
    SECRETS.add(value);
    return value;
  };
  /** @type {Row[]} */
  const rows = [];
  const notes = [
    `Packages \`@indx-workspace/aw@${options.version}\`, \`@indx-workspace/sdk@${options.version}\` and \`@indx-workspace/embedded@${options.version}\`, plus the \`claude-agent-sdk\` engine packages at the versions \`@indx-workspace/sdk/project\` pins, from ${options.registry}; model: live. The gallery is this checkout's \`tests/gallery\`; a project passes \`aw eval\` when the command exits 0.`,
  ];
  notes.push(`The gallery and this harness are commit \`${checkoutCommit()}\` of this checkout.`);
  if (apiKey === '') {
    notes.push(
      '`ANTHROPIC_API_KEY` is not set: every use-case row is `skipped`, and a skipped row fails the run; it is never a pass.',
    );
  }
  // Rewritten after every project, so a step timeout keeps the rows already produced.
  const save = () => {
    const markdown = summaryMarkdown(rows, notes, 'Use cases');
    writeFileSync(path.join(work, 'summary.md'), markdown);
    writeFileSync(path.join(work, 'results.json'), `${JSON.stringify(rows, null, 2)}\n`);
    return markdown;
  };
  try {
    const gallery = path.join(work, 'gallery');
    for (const name of ['shared', ...PROJECTS]) {
      cpSync(path.join(ROOT, 'tests', 'gallery', name), path.join(gallery, name), {
        recursive: true,
        filter: (file) => !file.endsWith('.test.ts') && !file.endsWith('benchmark.ts'),
      });
    }
    for (const id of PROJECTS) {
      writeFileSync(
        path.join(gallery, id, 'package.json'),
        `${JSON.stringify({ name: `use-case-${id}`, private: true, scripts: { dev: 'aw dev' } })}\n`,
      );
    }
    writeFileSync(
      path.join(gallery, 'package.json'),
      `${JSON.stringify({ name: 'use-cases', private: true })}\n`,
    );
    const started = performance.now();
    for (const [what, command] of installSteps(options.version)) {
      say(`== ${what}`);
      const installed = await machine.exec(command, { cwd: gallery, timeoutMs: commandMs });
      writeFileSync(path.join(logs, `${what.replace(/\W+/gu, '-')}.log`), scrub(installed.output));
      rows.push({
        where: 'tests/gallery',
        state: 'run',
        what,
        result: installed.status === 0 ? 'pass' : 'FAIL: the published package did not install',
        seconds: (performance.now() - started) / 1000,
        detail: installed.status === 0 ? undefined : scrub(installed.output),
      });
      if (installed.status !== 0) throw new JourneyFailure(`${what} failed`);
    }
    for (const id of PROJECTS) {
      say(`== ${id}`);
      rows.push(
        ...(await projectRows(machine, id, path.join(gallery, id), logs, { secret, apiKey })),
      );
      save();
    }
  } catch (error) {
    rows.push({
      where: 'tests/docs-claims/use-cases.mjs',
      state: 'run',
      what: 'the use cases',
      result: 'FAIL: the run stopped before every use case ran',
      detail: scrub(error instanceof Error ? error.message : String(error)),
    });
  } finally {
    const markdown = save();
    const summary = process.env['GITHUB_STEP_SUMMARY'];
    if (summary !== undefined && summary !== '' && existsSync(path.dirname(summary))) {
      appendFileSync(summary, `${markdown}\n`);
    }
    console.log(markdown.split('\n').slice(0, 3).join('\n'));
  }
  process.exitCode = exitCodeOf(rows);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(scrub(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
