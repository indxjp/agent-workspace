/**
 * One use-case project, run with the published `aw`: each step of the journey becomes a row of the
 * claims runner's format, and the scrubbed log of the project is written under `logs/`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { JourneyFailure } from '../journey/harness.mjs';
import { scrub } from '../journey/run.mjs';
import {
  chatFailedRunId,
  devEnvironment,
  failedRuns,
  firstPrompt,
  identityEnvironment,
  identityTargets,
  secretCreateCommand,
  serverCommands,
  STAND_IN,
  workspaceSecrets,
} from './use-cases-parse.mjs';
import {
  fileSetupCommands,
  listening,
  pointApisAtLoopback,
  startServer,
} from './use-cases-server.mjs';

/** @typedef {import('./run.mjs').Row} Row */
/** @typedef {import('./use-cases-parse.mjs').ServerCommand} ServerCommand */
/** @typedef {ReturnType<typeof import('./host.mjs').createHostMachine>} HostMachine */

const NEEDS_KEY = 'skipped: needs ANTHROPIC_API_KEY (not configured)';
const DEV_READY_MS = 3 * 60_000;
const SERVER_PORT_MS = 30_000;
const STEPS = [
  'MCP servers',
  'aw dev',
  'aw secrets create',
  'aw files',
  'aw push',
  'MCP servers, with ids',
  'aw check',
  'aw chat -p',
  'aw eval',
];

/** @param {unknown} error */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @typedef {object} Session what the steps of one project share
 * @property {HostMachine} machine
 * @property {string} id
 * @property {string} dir the project's copy
 * @property {string} projectYaml
 * @property {() => string} secret
 * @property {{ server: ServerCommand, stop: () => void }[]} running the MCP servers started so far
 * @property {ReturnType<typeof createRecorder>} recorder
 * @property {ReturnType<typeof createCommandRunner>} aw
 * @property {Record<string, string>} devEnv
 * @property {Record<string, string>} identitySecrets each identity secret has one value
 * @property {ReturnType<HostMachine['startDev']> | undefined} dev
 * @property {number} readyLength where the log of `aw dev` stands once it is ready
 */

/**
 * The rows of a project and its log: a step runs only while every earlier step passed.
 *
 * @param {string} where
 */
function createRecorder(where) {
  /** @type {Row[]} */
  const rows = [];
  let log = '';
  return {
    rows,
    /** @param {string} text */
    addLog(text) {
      log += text;
    },
    log: () => log,
    /** @param {string} what @param {() => Promise<string>} body its output; throws when it fails */
    async step(what, body) {
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
        const message = scrub(messageOf(error));
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
    },
  };
}

/**
 * @param {HostMachine} machine @param {string} dir
 * @returns {(command: string, options?: { env?: Record<string, string>, times?: number, allowFailure?: boolean }) => ReturnType<HostMachine['exec']>}
 *   `allowFailure` returns a non-zero exit instead of throwing it
 */
function createCommandRunner(machine, dir) {
  return async (command, { env = {}, times = 1, allowFailure = false } = {}) => {
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
}

/** @param {Session} session */
function createTracer({ aw }) {
  let traces = '';
  return {
    text: () => traces,
    /** @param {string} heading @param {string} runId append the trace of a run to the log */
    async traceRun(heading, runId) {
      traces += `== trace: ${heading}\n`;
      try {
        const trace = await aw(`aw runs trace ${runId}`, { allowFailure: true });
        traces +=
          trace.status === 0
            ? `${trace.output}\n`
            : `the trace could not be loaded: aw runs trace exited ${String(trace.status)}\n${trace.output}\n`;
      } catch (error) {
        traces += `the trace could not be loaded: ${messageOf(error)}\n`;
      }
    },
  };
}

/** @param {Session} session */
async function startServers({ dir, projectYaml, secret, devEnv, identitySecrets, running }) {
  // A secret both `aw dev` and a server are given is one value, as the project file says.
  const overrides = { FILE_ROOT: path.join(dir, 'data'), ...devEnv, ...identitySecrets };
  for (const server of serverCommands(projectYaml, secret, overrides)) {
    running.push({ server, stop: await startServer(dir, server) });
    if (STAND_IN.test(server.script)) pointApisAtLoopback(dir, server.port);
  }
  return '';
}

/** @param {Session} session */
async function startDev(session) {
  const dev = session.machine.startDev(session.dir, session.devEnv);
  session.dev = dev;
  await dev.untilWidget(DEV_READY_MS);
  // The ready screen, with its `widget:` line, comes before the first sync; a check made
  // before that sync ends sees a workspace without the project's skills and tools.
  await dev.until(
    (current) => current.syncs > 0 || /^sync: /mu.test(current.log),
    () => 'synced:',
    DEV_READY_MS,
  );
  session.readyLength = dev.state.log.length;
  return dev.state.log;
}

/** @param {Session} session */
async function createSecrets({ aw, identitySecrets }) {
  const names = Object.keys(identitySecrets);
  if (names.length === 0) return 'no workspace secrets to create';
  let output = '';
  for (const name of names) {
    const env = { IDENTITY_SECRET_VALUE: identitySecrets[name] ?? '' };
    output += (await aw(secretCreateCommand(name), { env })).output;
  }
  return output;
}

/** @param {Session} session */
async function uploadFiles({ aw, dir }) {
  const commands = fileSetupCommands(dir);
  if (commands.length === 0) return 'no files to upload';
  return (await aw(commands.join(' && '), { times: commands.length })).output;
}

/** @param {Session} session */
async function restartVerifyingServers({ aw, dir, running }) {
  // A server that verifies the caller assertion was started with the project file's
  // `<tool-id>` and `<workspace-id>`; the ids exist only now that aw push registered them.
  const verifying = running.filter((entry) => entry.server.identity !== undefined);
  if (verifying.length === 0) return 'no server verifies a caller assertion';
  const listed = await aw('aw connectors list --json');
  const targets = identityTargets(listed.stdout);
  const restarted = [];
  for (const entry of verifying) {
    const env = identityEnvironment(entry.server, targets);
    entry.stop();
    await listening(entry.server.port, SERVER_PORT_MS, false);
    entry.stop = await startServer(dir, entry.server, env);
    restarted.push(
      `${entry.server.script}: IDENTITY_AUDIENCE=${env['IDENTITY_AUDIENCE'] ?? ''} IDENTITY_WORKSPACE=${env['IDENTITY_WORKSPACE'] ?? ''}`,
    );
  }
  return restarted.join('\n');
}

/** @param {Session} session @param {string} prompt */
async function chatOnce({ aw, id }, tracer, prompt) {
  const command = `aw chat ${id} -p "$AW_PROMPT"`;
  const reply = await aw(command, { env: { AW_PROMPT: prompt }, allowFailure: true });
  if (reply.status !== 0) {
    const runId = chatFailedRunId(reply.output);
    if (runId !== undefined) await tracer.traceRun(`aw chat -p (${runId})`, runId);
    throw new JourneyFailure(`${command} exited ${String(reply.status)}\n${reply.output}`);
  }
  if (reply.stdout.trim() === '') throw new JourneyFailure('aw chat printed no answer');
  return reply.output;
}

/** @param {Session} session */
async function evaluate({ aw, id }, tracer) {
  // A failed suite still prints its results: the run of each failed case is traced.
  const command = `aw eval ${id} --json`;
  const result = await aw(command, { times: 3, allowFailure: true });
  if (result.status === 0) return result.stdout;
  for (const { name, runId, failures } of failedRuns(result.stdout)) {
    await tracer.traceRun(`${name} (${runId}) ${failures.join(' | ')}`, runId);
  }
  throw new JourneyFailure(`${command} exited ${String(result.status)}\n${result.output}`);
}

/** @param {Session} session @param {string} prompt */
async function runJourney(session, tracer, prompt) {
  const { step } = session.recorder;
  const { aw, devEnv } = session;
  await step('MCP servers', () => startServers(session));
  await step('aw dev', () => startDev(session));
  await step('aw secrets create', () => createSecrets(session));
  await step('aw files', () => uploadFiles(session));
  await step('aw push', async () => (await aw('aw push --yes', { env: devEnv })).output);
  await step('MCP servers, with ids', () => restartVerifyingServers(session));
  await step('aw check', async () => (await aw('aw check')).output);
  await step('aw chat -p', () => chatOnce(session, tracer, prompt));
  await step('aw eval', () => evaluate(session, tracer));
}

/** Stop `aw dev` on Ctrl+C, and log its server side of every run after the ready screen. */
async function stopDev({ dev, readyLength, recorder }, traces) {
  if (dev === undefined) return;
  try {
    await dev.stop((capMs) => capMs);
  } catch (error) {
    const started = recorder.rows.find((row) => row.what === 'aw dev');
    if (started !== undefined && started.result === 'pass') {
      started.result = 'FAIL: aw dev did not stop on Ctrl+C';
      started.detail = scrub(messageOf(error));
    }
    dev.kill();
  }
  // The trace of each failed eval case, from aw runs trace.
  if (traces !== '') recorder.addLog(scrub(traces));
  // The server's side of every run after the ready screen: why a run failed is logged here.
  recorder.addLog(
    `== aw dev, after the ready screen\n${scrub(dev.state.log.slice(readyLength))}\n`,
  );
}

/**
 * @param {HostMachine} machine
 * @param {{ id: string, dir: string, logs: string }} project `dir` is the project's copy
 * @param {{ secret: () => string, apiKey: string }} how
 * @returns {Promise<Row[]>}
 */
export async function projectRows(machine, { id, dir, logs }, how) {
  const where = `tests/gallery/${id}`;
  /** @param {string} result @param {string} [detail] */
  const all = (result, detail) =>
    STEPS.map((what) => ({ where, state: 'run', what, result, detail }));
  if (how.apiKey === '') return all(NEEDS_KEY);

  const projectYaml = readFileSync(path.join(dir, 'agent-workspace.yaml'), 'utf8');
  const prompt = firstPrompt(readFileSync(path.join(dir, 'evals', `${id}.yaml`), 'utf8'));
  if (prompt === undefined) return all('FAIL: no case in the eval file', `${id}: evals/${id}.yaml`);

  const recorder = createRecorder(where);
  /** @type {Session} */
  const session = {
    machine,
    id,
    dir,
    projectYaml,
    secret: how.secret,
    running: [],
    recorder,
    aw: createCommandRunner(machine, dir),
    devEnv: devEnvironment(projectYaml, how.secret),
    identitySecrets: Object.fromEntries(
      workspaceSecrets(projectYaml).map((name) => [name, how.secret()]),
    ),
    dev: undefined,
    readyLength: 0,
  };
  const tracer = createTracer(session);
  try {
    await runJourney(session, tracer, prompt);
  } finally {
    await stopDev(session, tracer.text());
    for (const { stop } of session.running) stop();
    writeFileSync(path.join(logs, `${id}.log`), recorder.log());
  }
  return recorder.rows;
}
