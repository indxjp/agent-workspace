/* global console, setTimeout, clearTimeout */
/**
 * What every part of the developer journey (`run.mjs`) shares: the paths inside the clean machine,
 * the run's secrets and how they are scrubbed, `docker exec` and the small file helpers over it.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { SETUP_QUESTIONS } from '@indx-workspace/contracts/setup';

import { JourneyFailure, createAnswerFor, redact, remainingMs, stringMapOf } from './harness.mjs';

const PARENT = '..';
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, PARENT, PARENT);

export const PREPARE_BUDGET_MS = 10 * 60_000;
export const CHECKS_BUDGET_MS = 10 * 60_000;
export const PREPARE_VARIABLE = 'JOURNEY_PREPARE_TIMEOUT_MS';
export const CHECKS_VARIABLE = 'JOURNEY_CHECKS_TIMEOUT_MS';
/**
 * How many prompts `npm create` may ask before the journey takes it for a question asked again:
 * every setup question, plus npm's install prompt and create's file-list confirmation (C20).
 */
const MAX_CREATE_ANSWERS = SETUP_QUESTIONS.length + 2;
export const CREATE_PACKAGE = '@indx-workspace@latest';
export const FAKE_KEY_PREFIX = 'sk-ant-e2e-fake-';
const NONCE_PREFIX = 'e2e-nonce-';

/** Paths inside the clean machine (POSIX). */
export const HOME = '/home/pwuser';
export const WORK_IN = `${HOME}/work`;
export const DEMO_IN = `${WORK_IN}/demo`;
export const DEMO_MCP_IN = `${WORK_IN}/demo-mcp`;
/** S2-08's second project, made by setup with the OpenAPI tool (B3a). */
export const DEMO_TOOLS_IN = `${WORK_IN}/demo-tools`;
/** J1's project (issue #1510), made by `npm create … --template portal`. */
export const PORTAL_IN = `${WORK_IN}/portal`;
export const RUNNER_IN = '/runner';
export const RUNNER_CACHE_IN = `${RUNNER_IN}/.npm`;
export const PID_FILE_IN = '/tmp/dev.pid';
export const HARNESS_IN = `${RUNNER_IN}/tests/journey/harness.mjs`;
export const CONFIG_IN = `${RUNNER_IN}/playwright.journey.config.mjs`;

export const CONFIG_FILE = 'playwright.journey.config.mjs';
export const SPEC_FILE = 'widget.e2e.mjs';
export const VIEWER_SPEC_FILE = 'viewer.e2e.mjs';
export const TOOLS_SPEC_FILE = 'tools.e2e.mjs';
export const RELEASE_SPEC_FILE = 'release.e2e.mjs';
export const FEEDBACK_SPEC_FILE = 'feedback.e2e.mjs';
export const PINNED_SPEC_FILE = 'pinned.e2e.mjs';
export const ORIGINS_SPEC_FILE = 'origins.e2e.mjs';
export const FILES_SPEC_FILE = 'files.e2e.mjs';
export const PORTAL_SPEC_FILE = 'portal.e2e.mjs';
export const FIRST_HOUR_SPEC_FILE = 'first-hour.e2e.mjs';
export const HARNESS_FILE = 'harness.mjs';
/** The page whose shell block the first-hour stopwatch runs unchanged. */
export const QUICKSTART_PAGE = path.join(
  'docs',
  'sdk',
  'site',
  'getting-started',
  'quickstart.mdx',
);

/** Every secret of this run, removed from anything it prints or writes as evidence. */
export const SECRETS = new Set();

/** @param {string} text */
export function scrub(text) {
  let clean = text;
  for (const secret of SECRETS) clean = redact(clean, secret);
  return clean;
}

/** @param {string} text */
export function say(text) {
  console.log(scrub(text));
}

/**
 * A setup question's prompt text, read from `SETUP_QUESTIONS` so the journey answers what
 * `npm create` actually asks.
 *
 * @param {string} id
 */
export function promptOf(id) {
  const question = SETUP_QUESTIONS.find((candidate) => candidate.id === id);
  if (question === undefined) throw new JourneyFailure(`setup asks no question ${id}`);
  return question.prompt;
}

/** @param {number} deadline epoch milliseconds */
export function remaining(deadline) {
  return remainingMs(deadline, Date.now(), PREPARE_VARIABLE);
}

/**
 * A command's timeout under the untimed checks' cap: its own `capMs`, or what is left of the cap.
 *
 * @param {number} deadline epoch milliseconds @returns {(capMs: number) => number}
 */
export function checksLimit(deadline) {
  return (capMs) => Math.min(capMs, remainingMs(deadline, Date.now(), CHECKS_VARIABLE));
}

/** A stop with no cap of its own. @param {number} capMs */
export const uncapped = (capMs) => capMs;

/** @returns {string} a nonce the fake provider recognises in a chat turn */
export function nonce() {
  return `${NONCE_PREFIX}${randomBytes(8).toString('hex')}`;
}

/** Appends Markdown to `$GITHUB_STEP_SUMMARY`, when the workflow gives one. @param {string} markdown */
export function appendSummary(markdown) {
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') appendFileSync(summary, markdown);
}

/** @param {string} evidence @param {string} name @param {string} text */
export function writeEvidence(evidence, name, text) {
  writeFileSync(path.join(evidence, name), scrub(text));
}

/**
 * The `docker exec` argument list: no `-t`, so npm exec takes yes on a non-TTY. `--env NAME` has no
 * value: docker reads it from its own environment, so a secret is never on a command line.
 *
 * @param {string} container @param {readonly string[]} command
 * @param {{ workdir?: string, user?: string, env?: Readonly<Record<string, string>>, input?: string }} options
 */
function execArguments(container, command, options) {
  const args = ['exec'];
  if (options.input !== undefined) args.push('--interactive');
  if (options.workdir !== undefined) args.push('--workdir', options.workdir);
  if (options.user !== undefined) args.push('--user', options.user);
  for (const name of Object.keys(options.env ?? {})) args.push('--env', name);
  args.push(container, ...command);
  return args;
}

/**
 * `docker exec` in the clean machine. Its output is streamed (scrubbed) and collected.
 * Asynchronous, so the fake provider keeps answering.
 *
 * @param {string} container @param {readonly string[]} command
 * @param {{ workdir?: string, user?: string, env?: Readonly<Record<string, string>>,
 *   input?: string, timeoutMs: number, quiet?: boolean }} options
 * @returns {Promise<{ status: number | null, output: string, stdout: string }>}
 */
export function exec(container, command, options) {
  const args = execArguments(container, command, options);
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      env: { ...process.env, ...options.env },
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stdout = '';
    /** @param {boolean} isStdout @param {Buffer} chunk */
    const collect = (isStdout, chunk) => {
      const text = chunk.toString('utf8');
      output += text;
      if (isStdout) stdout += text;
      if (options.quiet !== true) process.stdout.write(scrub(text));
    };
    child.stdout?.on('data', (chunk) => collect(true, chunk));
    child.stderr?.on('data', (chunk) => collect(false, chunk));
    if (options.input !== undefined) child.stdin?.end(options.input);
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status, output, stdout });
    });
  });
}

/**
 * `exec` that must exit 0, or the run stops with the command and its (scrubbed) output.
 *
 * @param {string} container @param {readonly string[]} command
 * @param {Parameters<typeof exec>[2]} options
 */
export async function execOk(container, command, options) {
  const result = await exec(container, command, options);
  if (result.status !== 0) {
    throw new JourneyFailure(
      `${command.join(' ')} exited ${String(result.status)}\n${scrub(result.output)}`,
    );
  }
  return result;
}

/**
 * `npm create` on a terminal, answered as a user answers it. `script` (util-linux, in every Ubuntu
 * image) gives the command a pseudo-terminal, so create asks its setup questions; each prompt it
 * waits on is answered by {@link createAnswerFor} over `docker exec --interactive`'s stdin. It
 * must exit 0 after at most {@link MAX_CREATE_ANSWERS} answers.
 *
 * @param {string} container @param {string} command one shell command line, no secret in it
 * @param {{ workdir: string, timeoutMs: number, answers: Readonly<Record<string, string>> }} options
 *   `answers` by prompt text; every other question takes the recommended answer
 * @returns {Promise<void>}
 */
export function execAnswering(container, command, options) {
  // CI=false: the runner sets CI, and create asks nothing when CI is set (#879).
  const args = ['exec', '--interactive', '--env', 'CI=false', '--workdir', options.workdir];
  args.push(container, 'script', '--quiet', '--return', '--flush', '--command', command);
  args.push('/dev/null');
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let screen = '';
    let answers = 0;
    /** @type {JourneyFailure | null} */
    let refused = null;
    /** @param {Buffer} chunk */
    const collect = (chunk) => {
      const text = chunk.toString('utf8');
      output += text;
      screen += text;
      process.stdout.write(scrub(text));
      const answer = createAnswerFor(screen, options.answers);
      if (answer === null) return;
      answers += 1;
      if (answers > MAX_CREATE_ANSWERS) {
        refused = new JourneyFailure(
          `${command} asked more than ${String(MAX_CREATE_ANSWERS)} questions; an answer was refused`,
        );
        child.kill('SIGKILL');
        return;
      }
      screen = '';
      child.stdin.write(`${answer}\n`);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      child.stdin.destroy();
      if (refused !== null) reject(refused);
      else if (status === 0) resolve();
      else reject(new JourneyFailure(`${command} exited ${String(status)}\n${scrub(output)}`));
    });
  });
}

/** @param {string} machine @param {number} timeoutMs @param {string} [dir] */
export async function snapshotDemo(machine, timeoutMs, dir = DEMO_IN) {
  const result = await execOk(machine, ['node', HARNESS_IN, 'snapshot', dir], {
    timeoutMs,
    quiet: true,
  });
  return stringMapOf(result.stdout, 'harness.mjs snapshot');
}

/**
 * Writes `contents` to `file` (absolute, in the clean machine) over the exec's stdin, creating
 * its directory: what a person saving a file in an editor does.
 *
 * @param {string} machine @param {string} file @param {string} contents @param {number} timeoutMs
 */
export async function writeIn(machine, file, contents, timeoutMs) {
  await execOk(machine, ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', file], {
    input: contents,
    timeoutMs,
    quiet: true,
  });
}

/** @param {string} machine @param {string} file @param {number} timeoutMs */
export async function readIn(machine, file, timeoutMs) {
  return (await execOk(machine, ['cat', file], { timeoutMs, quiet: true })).stdout;
}
