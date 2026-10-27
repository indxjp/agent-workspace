#!/usr/bin/env node
/* global console */
/**
 * Runs every claim the docs, the landing page and the READMEs make (issue #880), and prints one row
 * per claim: `page:line | state | command or file | result | duration`.
 *
 *   pnpm build && node tests/docs-claims/run.mjs
 *
 * - `file` claims are compared with the repository file they copy (`static.mjs`), as is the stack
 *   builder's flag table against `SETUP_QUESTIONS` and the one install block every page shows.
 * - `run` claims execute in the journey's clean container (`tests/journey/run.mjs`: the digest-pinned
 *   Verdaccio holding this checkout's eight packages, the fake Anthropic API, a Playwright-image
 *   machine as `pwuser`), page by page in order, each page in a directory of its own, with `CI=true`
 *   and no terminal, every command under a timeout and expected to exit 0. Every command runs with
 *   `NPM_CONFIG_PREFIX=$HOME/.npm-global` and its `bin` on `PATH`, so a global `npm install` needs
 *   no `sudo` here, unlike a default Node install. `cd` moves the page's
 *   directory, and a block that starts with `npm create` starts in a new one (it is another way to
 *   start, not a step after the blocks above it); `npm run dev` is started, waited on until it is ready and signed in, then stopped
 *   with Ctrl+C. Pages whose commands are the same run once and say so. A page whose only commands
 *   are the first `sh` block of `getting-started/quickstart.mdx` is not run here when the machine,
 *   registry and model are the journey's own (the default): journey-e2e's first-hour leg runs that
 *   block unchanged on the same container, Verdaccio and fake model (T1-T3) and asks the agent it
 *   starts a question (T4), and the journey leg stops `npm run dev` with Ctrl+C. Its rows say so.
 *   Then the real `aw` binary
 *   shows the "running without a person" rows of `cli/overview.mdx`: `aw init` without `--yes`, `aw
 *   login` and a silent pipe on `--api-key-stdin`.
 * - `compile` claims are written to a scratch project in the container with the packed packages
 *   installed, and type-checked by one `tsc --noEmit`; a diagnostic is reported at the page line.
 * - `illustrative` and `generated` claims are listed, never run.
 *
 * Switches: `--registry <url>` installs from that registry instead of a Verdaccio of this checkout
 * (nothing is packed or published); `--model live` uses the real Anthropic API under
 * `ANTHROPIC_API_KEY` instead of the fake; `--static` runs only the claims that need no container.
 * `--machine host` (issue #881, the `install-live` workflow) runs the claims on this computer
 * instead of in the container, in the shell `--shell sh|bash|pwsh` names, in a home directory of the
 * run's own (`host.mjs`); it needs `--registry`. A block marked for another shell reads `n/a`.
 * `--model live` without a key is not an error: every row from a page's first `npm run dev` on reads
 * `skipped`, and the run exits 1 for a skipped row as it does for a failing one, so a missing key
 * is never a pass.
 * Environment: `DOCS_CLAIMS_WORK_DIR` (default: a temporary directory), `DOCS_CLAIMS_COMMAND_TIMEOUT_MS`
 * (5 minutes per command), `JOURNEY_REGISTRY_PORT` and `JOURNEY_PREPARE_TIMEOUT_MS` as for the journey.
 * The table goes to `$GITHUB_STEP_SUMMARY`; `results.json`, `summary.md` and one scrubbed log per
 * page go to `<work>/`, which the CI job uploads. A page's directory is removed once its log is
 * written, so the per-page `node_modules` does not fill the runner's disk.
 */
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { run } from '../generated-project/project.mjs';
import { positiveIntegerVariable } from '../generated-project/run.mjs';
import {
  JourneyFailure,
  quickstartCommands,
  registryOf,
  workDirectoryOf,
} from '../journey/harness.mjs';
import {
  FAKE_KEY_PREFIX,
  HOME,
  SECRETS,
  exec,
  execOk,
  pinnedVersion,
  publishPackages,
  removeContainer,
  say,
  scrub,
  startDev,
  startFakeProvider,
  startMachine,
  startRegistry,
} from '../journey/run.mjs';
import { extractRepositoryClaims, shellCommands } from './extract.mjs';
import { SHELL_NAMES, createHostMachine } from './host.mjs';
import { galleryProblems, installProblems, stackFlagProblems } from './static.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLAIMS_IN = `${HOME}/claims`;
const COMPILE_IN = `${HOME}/compile`;
const PREFIX_IN = `${HOME}/.npm-global`;
const SHELL_SETUP = `export PATH="${PREFIX_IN}/bin:$PATH" NPM_CONFIG_PREFIX="${PREFIX_IN}"; `;
const COMMAND_VARIABLE = 'DOCS_CLAIMS_COMMAND_TIMEOUT_MS';
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const DEV_READY_MS = 3 * 60_000;
const DEV_COMMAND = 'npm run dev';
const NEEDS_KEY = 'skipped: needs ANTHROPIC_API_KEY (not configured)';
const STACK_BUILDER = 'sites/lp/assets/site.js';
const CLI_PAGE = 'docs/sdk/site/cli/overview.mdx';
const QUICKSTART_PAGE = 'docs/sdk/site/getting-started/quickstart.mdx';
const FIRST_HOUR_OWNS = 'owned by journey-e2e first-hour (T1-T3 run these commands)';
const MAX_WHAT = 90;
const MAX_DETAIL_LINES = 40;

/**
 * @typedef {import('./extract.mjs').Claim} Claim
 * @typedef {{ where: string, state: string, what: string, result: string, seconds?: number,
 *   detail?: string }} Row
 * @typedef {{ claim: Claim, commands: string[], fresh?: boolean, sameAsLine?: number }} Block
 * @typedef {{ page: string, slug: string, blocks: Block[], sameAsPage?: string }} PagePlan
 */

/**
 * @param {readonly string[]} argv @param {Readonly<Record<string, string | undefined>>} env
 * @returns {{ registry: string | null, live: boolean, apiKey: string, staticOnly: boolean,
 *   machine: 'container' | 'host', shell: string }}
 */
export function parseArguments(argv, env) {
  const usage =
    'usage: node tests/docs-claims/run.mjs [--registry <url>] [--model fake|live] [--static] [--machine container|host [--shell sh|bash|pwsh]]';
  /** @type {{ registry?: string, model?: string, static?: boolean, machine?: string, shell?: string }} */
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        registry: { type: 'string' },
        model: { type: 'string' },
        static: { type: 'boolean' },
        machine: { type: 'string' },
        shell: { type: 'string' },
      },
      strict: true,
    }));
  } catch (error) {
    throw new JourneyFailure(
      `${usage} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const model = values.model ?? 'fake';
  if (model !== 'fake' && model !== 'live') {
    throw new JourneyFailure(`${usage} (--model is fake or live, not "${model}")`);
  }
  const machine = values.machine ?? 'container';
  if (machine !== 'container' && machine !== 'host') {
    throw new JourneyFailure(`${usage} (--machine is container or host, not "${machine}")`);
  }
  if (values.shell !== undefined && !SHELL_NAMES.includes(values.shell)) {
    throw new JourneyFailure(
      `${usage} (--shell is ${SHELL_NAMES.join(', ')}, not "${values.shell}")`,
    );
  }
  if (machine === 'container' && values.shell !== undefined) {
    throw new JourneyFailure(`${usage} (--shell needs --machine host; the container runs sh)`);
  }
  const registry = registryOf(values.registry);
  if (machine === 'host' && registry === null) {
    throw new JourneyFailure(`${usage} (--machine host needs --registry: there is no Verdaccio)`);
  }
  return {
    registry,
    live: model === 'live',
    apiKey: env['ANTHROPIC_API_KEY']?.trim() ?? '',
    staticOnly: values.static === true,
    machine,
    shell: values.shell ?? 'sh',
  };
}

/** @param {string} page */
const slugOf = (page) => page.replace(/[^a-z0-9]+/giu, '-').replace(/^-+|-+$/gu, '');

/**
 * The run claims by page, in page order. A block whose commands an earlier block of its page already
 * ran is not run again, and a page whose distinct blocks are those of an earlier page runs once.
 *
 * @param {readonly Claim[]} claims
 * @returns {PagePlan[]}
 */
export function runPlans(claims) {
  /** @type {PagePlan[]} */
  const plans = [];
  /** @type {Map<string, string>} */
  const seenPages = new Map();
  for (const claim of claims) {
    if (claim.state !== 'run') continue;
    let plan = plans.find((candidate) => candidate.page === claim.page);
    if (plan === undefined) {
      plan = { page: claim.page, slug: slugOf(claim.page), blocks: [] };
      plans.push(plan);
    }
    const commands = shellCommands(claim.body);
    const same = plan.blocks.find((block) => block.commands.join('\n') === commands.join('\n'));
    // A block that creates a project is another way to start, not a step after the blocks above it.
    const fresh = commands[0]?.startsWith('npm create ') === true ? { fresh: true } : {};
    plan.blocks.push(
      same === undefined
        ? { claim, commands, ...fresh }
        : { claim, commands, ...fresh, sameAsLine: same.claim.line },
    );
  }
  for (const plan of plans) {
    const key = plan.blocks
      .filter((block) => block.sameAsLine === undefined)
      .map((block) => block.commands.join('\n'))
      .join('\n--\n');
    const earlier = seenPages.get(key);
    if (earlier === undefined) seenPages.set(key, plan.page);
    else plan.sameAsPage = earlier;
  }
  return plans;
}

/**
 * Each compile claim as a file of the scratch project; the trailing `export {}` makes it a module
 * of its own, so two samples never share a global name.
 *
 * @param {readonly Claim[]} claims
 * @returns {{ claim: Claim, name: string, text: string }[]}
 */
export function compileSources(claims) {
  return claims
    .filter((claim) => claim.state === 'compile')
    .map((claim, index) => ({
      claim,
      name: `src/c${String(index)}.${claim.lang === 'tsx' ? 'tsx' : 'ts'}`,
      text: `${claim.body}\nexport {};\n`,
    }));
}

/**
 * `tsc --pretty false` output by file: the line of each `error TSnnnn`, and its message.
 *
 * @param {string} output
 * @returns {Map<string, { line: number, message: string }[]>}
 */
export function tscDiagnostics(output) {
  /** @type {Map<string, { line: number, message: string }[]>} */
  const byFile = new Map();
  for (const match of output.matchAll(/^(src\/c\d+\.tsx?)\((\d+),\d+\): (error TS\d+: .*)$/gmu)) {
    const [, file = '', line = '0', message = ''] = match;
    byFile.set(file, [...(byFile.get(file) ?? []), { line: Number(line), message }]);
  }
  return byFile;
}

/** @param {string} text @param {number} [max] */
function cell(text, max = MAX_WHAT) {
  const one = text.replace(/\s+/gu, ' ').trim().replace(/\|/gu, '\\|');
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * 1 when a claim failed or was skipped: a skipped claim (no key) is not a pass. `n/a` rows (written
 * for another shell, or needing something this machine lacks) are not counted against the run.
 *
 * @param {readonly Row[]} rows
 */
export function exitCodeOf(rows) {
  return rows.some((row) => row.result.startsWith('FAIL') || row.result.startsWith('skipped'))
    ? 1
    : 0;
}

/**
 * The summary table, and under it what each failing claim printed.
 *
 * @param {readonly Row[]} rows @param {readonly string[]} notes @param {string} [title]
 */
export function summaryMarkdown(rows, notes, title = 'Docs claims') {
  const failing = rows.filter((row) => row.result.startsWith('FAIL'));
  const skipped = rows.filter((row) => row.result.startsWith('skipped'));
  const unavailable = rows.filter((row) => row.result.startsWith('n/a'));
  /** @type {Record<string, number>} */
  const states = {};
  for (const row of rows) states[row.state] = (states[row.state] ?? 0) + 1;
  const counts = Object.entries(states)
    .map(([state, count]) => `${String(count)} ${state}`)
    .join(', ');
  return [
    `### ${title}: ${String(rows.length)} claims (${counts}), ${String(failing.length)} failing, ${String(skipped.length)} skipped, ${String(unavailable.length)} n/a`,
    '',
    ...notes.map((note) => `${note}\n`),
    '| page:line | state | command or file | result | duration |',
    '| --- | --- | --- | --- | ---: |',
    ...rows.map(
      (row) =>
        `| ${cell(row.where, 80)} | ${row.state} | ${cell(row.what)} | ${cell(row.result, 70)} | ${
          row.seconds === undefined ? '' : `${row.seconds.toFixed(1)} s`
        } |`,
    ),
    '',
    ...failing.flatMap((row) => [
      `#### ${row.where}`,
      '',
      '```text',
      scrub((row.detail ?? row.result).split('\n').slice(0, MAX_DETAIL_LINES).join('\n')),
      '```',
      '',
    ]),
  ].join('\n');
}

/** @param {string} file @returns {string | undefined} */
function readRepositoryFile(file) {
  try {
    return readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    return undefined;
  }
}

/** @param {string} page @param {string} needle */
function lineOf(page, needle) {
  const index = (readRepositoryFile(page) ?? '').split('\n').findIndex((l) => l.includes(needle));
  return index < 0 ? 1 : index + 1;
}

/** @param {Claim} claim */
const whereOf = (claim) => `${claim.page}:${String(claim.line)}`;

/** @param {string} body */
const firstLine = (body) => body.split('\n').find((line) => line.trim() !== '') ?? '';

/**
 * The claims that need no container: file copies, the stack builder's flags, the install block;
 * plus a row for every illustrative and generated claim.
 *
 * @param {readonly Claim[]} claims @param {readonly string[]} questionFlags
 * @returns {Row[]}
 */
export function staticRows(claims, questionFlags) {
  /** @type {Row[]} */
  const rows = [];
  for (const claim of claims) {
    if (claim.state === 'file') {
      const problems = galleryProblems([claim], readRepositoryFile);
      rows.push({
        where: whereOf(claim),
        state: 'file',
        what: claim.file ?? '',
        result: problems.length === 0 ? 'pass' : 'FAIL: differs from the file',
        detail: problems.join('\n'),
      });
    } else if (claim.state === 'illustrative') {
      rows.push({
        where: whereOf(claim),
        state: 'illustrative',
        what: firstLine(claim.body),
        result: 'labelled on the page',
      });
    } else if (claim.state === 'generated') {
      rows.push({
        where: whereOf(claim),
        state: 'generated',
        what: firstLine(claim.body),
        result: 'checked by pnpm docs:check',
      });
    }
  }
  const flags = stackFlagProblems(readRepositoryFile(STACK_BUILDER) ?? '', questionFlags);
  rows.push({
    where: STACK_BUILDER,
    state: 'file',
    what: 'CREATE_FLAGS against SETUP_QUESTIONS',
    result: flags.length === 0 ? 'pass' : 'FAIL: a flag npm create does not have',
    detail: flags.join('\n'),
  });
  const installs = installProblems(claims);
  rows.push({
    where: 'README.md, quickstart.mdx, index.html',
    state: 'file',
    what: 'one non-interactive install block',
    result: installs.length === 0 ? 'pass' : 'FAIL: the install blocks differ',
    detail: installs.join('\n'),
  });
  return rows;
}

/**
 * Where the commands run: the journey's clean container, or this computer (`host.mjs`).
 *
 * @typedef {{ kind: 'container' | 'host', shell: 'posix' | 'powershell', fifo: boolean,
 *   env: Readonly<Record<string, string>>, commandMs: number, logs: string, claims: string,
 *   compile: string, resolve: (cwd: string, to: string) => string,
 *   mkdir: (dir: string) => Promise<unknown>, project: (dir: string) => Promise<unknown>,
 *   remove: (dir: string) => Promise<unknown>, list: (dir: string) => Promise<string[]>,
 *   stageCompile: (stage: string) => Promise<string>,
 *   exec: (command: string, run: { cwd: string, env?: Readonly<Record<string, string>>,
 *     timeoutMs: number }) => Promise<{ status: number | null, output: string, stdout: string }>,
 *   startDev: (cwd: string, env?: Readonly<Record<string, string>>) => ReturnType<typeof startDev>,
 * }} Machine
 */

/** @param {string} command */
const shell = (command) => ['sh', '-c', `${SHELL_SETUP}${command}`];

/**
 * The journey's container as a {@link Machine}.
 *
 * @param {string} name @param {Record<string, string>} env @param {number} commandMs
 * @param {string} logs
 * @returns {Machine}
 */
function containerMachine(name, env, commandMs, logs) {
  return {
    kind: 'container',
    shell: 'posix',
    fifo: true,
    env,
    commandMs,
    logs,
    claims: CLAIMS_IN,
    compile: COMPILE_IN,
    resolve: (cwd, to) => path.posix.resolve(cwd, to),
    mkdir: (dir) => execOk(name, ['mkdir', '-p', dir], { timeoutMs: 60_000, quiet: true }),
    project: (dir) => execOk(name, ['mkdir', '-p', dir], { timeoutMs: 60_000, quiet: true }),
    remove: (dir) => execOk(name, ['rm', '-rf', dir], { timeoutMs: 60_000, quiet: true }),
    list: async (dir) =>
      (await exec(name, shell('ls -A'), { workdir: dir, timeoutMs: 60_000, quiet: true })).stdout
        .split('\n')
        .filter((line) => line !== ''),
    stageCompile: async (stage) => {
      run('docker', ['cp', stage, `${name}:${COMPILE_IN}`], { timeoutMs: 120_000 });
      await execOk(name, ['chown', '-R', 'pwuser:pwuser', COMPILE_IN], {
        user: 'root',
        timeoutMs: 60_000,
        quiet: true,
      });
      return COMPILE_IN;
    },
    exec: (command, how) =>
      exec(name, shell(command), {
        workdir: how.cwd,
        env: { ...env, ...how.env },
        timeoutMs: how.timeoutMs,
        quiet: true,
      }),
    startDev: (cwd, extra) => startDev(name, cwd, { ...env, ...extra }),
  };
}

/**
 * One command of a block. `cd` moves the page's directory; `npm run dev` runs until ready and is
 * stopped; anything else is a shell command that must exit 0.
 *
 * @param {Machine} machine @param {{ cwd: string }} state @param {string} command
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
async function runCommand(machine, state, command) {
  const cd = /^cd (\S+)$/u.exec(command);
  if (cd?.[1] !== undefined) {
    state.cwd = machine.resolve(state.cwd, cd[1]);
    return { ok: true, output: `$ ${command}\n` };
  }
  if (command === DEV_COMMAND) {
    const dev = machine.startDev(state.cwd);
    try {
      await dev.untilWidget(DEV_READY_MS);
      await dev.stop((capMs) => capMs);
      return { ok: true, output: `$ ${command}\n${dev.state.log}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, output: `$ ${command}\n${dev.state.log}\n${message}\n` };
    } finally {
      // On the failure path `npm run dev` is still running and holds port 3000; killing only the
      // local side of a `docker exec` would leave it there for every later page, so the process
      // group is stopped first (the success path already did, setting `exit`).
      if (dev.state.exit === undefined) await dev.stop((capMs) => capMs).catch(() => undefined);
      dev.kill();
    }
  }
  const result = await machine.exec(command, { cwd: state.cwd, timeoutMs: machine.commandMs });
  return {
    ok: result.status === 0,
    output: `$ ${command}\n${result.output}\nexit ${String(result.status)}\n`,
  };
}

/**
 * The rows of a page whose every run block is `owned` (the commands journey-e2e's first-hour leg
 * runs), or null when the page has a block of its own to run. An empty `owned` owns nothing.
 *
 * @param {PagePlan} plan @param {readonly string[]} owned
 * @returns {Row[] | null}
 */
export function ownedRows(plan, owned) {
  const key = owned.join('\n');
  if (key === '' || !plan.blocks.every((block) => block.commands.join('\n') === key)) return null;
  return plan.blocks.map((block) => ({
    where: whereOf(block.claim),
    state: 'run',
    what: block.commands.join(' ; '),
    result: FIRST_HOUR_OWNS,
  }));
}

/**
 * @param {Machine} machine @param {PagePlan} plan
 * @param {Map<string, Row[]>} done the rows of the pages already run, by page
 * @param {boolean} modelMissing whether the live model has no key, so `npm run dev` cannot run
 * @returns {Promise<Row[]>}
 */
export async function runPage(machine, plan, done, modelMissing) {
  const earlier = plan.sameAsPage === undefined ? undefined : done.get(plan.sameAsPage);
  if (plan.sameAsPage !== undefined && earlier !== undefined) {
    return plan.blocks.map((block) => ({
      where: whereOf(block.claim),
      state: 'run',
      what: block.commands.join(' ; '),
      result: earlier.some((row) => row.result.startsWith('FAIL'))
        ? `FAIL: same commands as ${plan.sameAsPage}, which failed`
        : earlier.some((row) => row.result.startsWith('skipped'))
          ? `skipped: same commands as ${plan.sameAsPage}, which were`
          : `pass (same commands as ${plan.sameAsPage})`,
    }));
  }
  // An empty slug resolves to the claims root itself, which the cleanup below would remove.
  if (plan.slug === '') throw new JourneyFailure(`${plan.page} has no slug to name its directory`);
  const dir = machine.resolve(machine.claims, plan.slug);
  await machine.project(dir);
  const state = { cwd: dir };
  let log = '';
  let failed = false;
  let withoutModel = false;
  /** @type {Row[]} */
  const rows = [];
  try {
    for (const block of plan.blocks) {
      const where = whereOf(block.claim);
      const what = block.commands.join(' ; ');
      if (block.sameAsLine !== undefined) {
        rows.push({
          where,
          state: 'run',
          what,
          result: `pass (same commands as :${String(block.sameAsLine)})`,
        });
        continue;
      }
      if (block.claim.shell !== undefined && block.claim.shell !== machine.shell) {
        rows.push({ where, state: 'run', what, result: `n/a (${block.claim.shell} only)` });
        continue;
      }
      if (failed) {
        rows.push({
          where,
          state: 'run',
          what,
          result: 'skipped: an earlier block of the page failed',
        });
        continue;
      }
      if (withoutModel) {
        rows.push({ where, state: 'run', what, result: NEEDS_KEY });
        continue;
      }
      if (block.fresh === true) {
        state.cwd = machine.resolve(dir, String(block.claim.line));
        await machine.project(state.cwd);
      }
      const started = performance.now();
      let detail = '';
      for (const command of block.commands) {
        if (modelMissing && command === DEV_COMMAND) {
          withoutModel = true;
          break;
        }
        let outcome;
        try {
          outcome = await runCommand(machine, state, command);
        } catch (error) {
          outcome = {
            ok: false,
            output: `$ ${command}\n${error instanceof Error ? error.message : String(error)}\n`,
          };
        }
        detail += outcome.output;
        if (!outcome.ok) {
          failed = true;
          break;
        }
      }
      log += `== ${where}\n${scrub(detail)}\n`;
      rows.push({
        where,
        state: 'run',
        what,
        result: failed ? 'FAIL: a command did not exit 0' : withoutModel ? NEEDS_KEY : 'pass',
        seconds: (performance.now() - started) / 1000,
        detail: failed ? detail : undefined,
      });
      say(`${where} ${failed ? 'FAIL' : withoutModel ? 'skipped' : 'pass'}`);
    }
  } finally {
    // Each page's project holds a full node_modules and embedded PostgreSQL; nothing reads it once
    // the log is written, and kept for every page it fills the runner's disk (#1098).
    try {
      writeFileSync(path.join(machine.logs, `${plan.slug}.log`), log);
    } finally {
      await machine.remove(dir).catch((/** @type {unknown} */ error) => {
        say(
          `could not remove ${dir}: ${scrub(error instanceof Error ? error.message : String(error))}`,
        );
      });
    }
  }
  return rows;
}

/**
 * The "running without a person" rows of `cli/overview.mdx`, on the real `aw` binary.
 *
 * @param {Machine} machine
 * @returns {Promise<Row[]>}
 */
async function personRows(machine) {
  const env = { AGENT_WORKSPACE_URL: 'http://127.0.0.1:9' };
  const dir = machine.resolve(machine.claims, 'aw-without-a-person');
  await machine.mkdir(dir);
  /** @param {string} command @param {number} timeoutMs */
  const aw = (command, timeoutMs) => machine.exec(command, { cwd: dir, env, timeoutMs });
  /** @type {Row[]} */
  const rows = [];
  /**
   * @param {string} needle the overview table's row @param {string} what
   * @param {() => Promise<string | null>} check null when it holds, else what went wrong
   * @param {string | null} [unavailable] why this machine cannot show the row, if it cannot
   */
  const row = async (needle, what, check, unavailable = null) => {
    const where = `${CLI_PAGE}:${String(lineOf(CLI_PAGE, needle))}`;
    if (unavailable !== null) {
      rows.push({ where, state: 'run', what, result: `n/a (${unavailable})` });
      return;
    }
    const started = performance.now();
    let problem;
    try {
      problem = await check();
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    rows.push({
      where,
      state: 'run',
      what,
      result: problem === null ? 'pass' : 'FAIL: not what the page says',
      seconds: (performance.now() - started) / 1000,
      detail: problem ?? undefined,
    });
  };

  await row(
    '| `aw init`',
    'aw init, no terminal, no --yes: exit 1, fix: aw init --yes, no file',
    async () => {
      const result = await aw('aw init', machine.commandMs);
      const listing = (await machine.list(dir)).join(' ');
      if (result.status !== 1) return `exit ${String(result.status)}, not 1\n${result.output}`;
      if (!result.output.includes('fix: aw init --yes'))
        return `no "fix: aw init --yes" line\n${result.output}`;
      if (listing !== '') return `it wrote ${listing}`;
      return null;
    },
  );
  // Every machine's environment has CI=true, which is what the page's row is about.
  await row(
    '| `aw login`',
    'CI=true aw login: exit 1, fix: set AGENT_WORKSPACE_API_KEY',
    async () => {
      const result = await aw('aw login', machine.commandMs);
      if (result.status !== 1) return `exit ${String(result.status)}, not 1\n${result.output}`;
      if (!result.output.includes('fix: set AGENT_WORKSPACE_API_KEY')) {
        return `no "fix: set AGENT_WORKSPACE_API_KEY" line\n${result.output}`;
      }
      return null;
    },
  );
  await row(
    '--api-key-stdin',
    'aw --api-key-stdin on a pipe that stays silent: exit 2 after ten seconds',
    async () => {
      // A fifo held open by this shell: stdin is a pipe that never writes and never closes.
      const result = await aw(
        'f=$(mktemp -u); mkfifo "$f"; exec 3<>"$f"; s=$(date +%s); aw agents list --api-key-stdin < "$f"; c=$?; echo "exit=$c seconds=$(( $(date +%s) - s ))"',
        machine.commandMs,
      );
      const seen = /exit=(\d+) seconds=(\d+)/u.exec(result.output);
      const code = Number(seen?.[1]);
      const seconds = Number(seen?.[2]);
      if (seen === null || code !== 2 || seconds < 9 || seconds > 20) {
        return `expected exit 2 after about ten seconds\n${result.output}`;
      }
      return null;
    },
    machine.fifo ? null : 'needs a POSIX fifo',
  );
  return rows;
}

/**
 * Every compile claim in one scratch project with the packed packages, one `tsc --noEmit`.
 *
 * @param {Machine} machine @param {readonly Claim[]} claims @param {string} work
 * @returns {Promise<Row[]>}
 */
async function compileRows(machine, claims, work) {
  const sources = compileSources(claims);
  if (sources.length === 0) return [];
  const stage = path.join(work, 'compile-stage');
  mkdirSync(path.join(stage, 'src'), { recursive: true });
  for (const { name, text } of sources) writeFileSync(path.join(stage, name), text);
  writeFileSync(
    path.join(stage, 'package.json'),
    `${JSON.stringify({ name: 'docs-claims-compile', private: true }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(stage, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'es2023',
          module: 'esnext',
          moduleResolution: 'bundler',
          lib: ['es2023', 'dom'],
          jsx: 'react-jsx',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ['node'],
        },
        include: ['src'],
      },
      null,
      2,
    )}\n`,
  );
  const where = await machine.stageCompile(stage);
  const react = path.join(ROOT, 'packages', 'react');
  const started = performance.now();
  const install = await machine.exec(
    [
      'npm install --no-audit --no-fund',
      "'@indx-workspace/contracts'",
      "'@indx-workspace/sdk'",
      "'@indx-workspace/react'",
      `typescript@${pinnedVersion(ROOT, 'typescript')}`,
      `@types/node@${pinnedVersion(ROOT, '@types/node')}`,
      `vitest@${pinnedVersion(ROOT, 'vitest')}`,
      `react@${pinnedVersion(react, 'react')}`,
      `@types/react@${pinnedVersion(react, '@types/react')}`,
    ].join(' '),
    { cwd: where, timeoutMs: machine.commandMs },
  );
  const tsc =
    install.status === 0
      ? await machine.exec('npx tsc --noEmit --pretty false -p .', {
          cwd: where,
          timeoutMs: machine.commandMs,
        })
      : install;
  const output = scrub(tsc.output);
  writeFileSync(path.join(machine.logs, 'compile.log'), output);
  const seconds = (performance.now() - started) / 1000;
  const diagnostics = tscDiagnostics(output);
  const infrastructure = install.status !== 0 || (tsc.status !== 0 && diagnostics.size === 0);
  return sources.map(({ claim, name }) => {
    const found = diagnostics.get(name) ?? [];
    const first = found[0];
    const failed = infrastructure || first !== undefined;
    return {
      where:
        first === undefined ? whereOf(claim) : `${claim.page}:${String(claim.line + first.line)}`,
      state: 'compile',
      what: `${claim.lang} block, ${String(claim.body.split('\n').length)} lines`,
      result: failed ? 'FAIL: does not type-check' : 'pass',
      seconds: seconds / sources.length,
      detail: failed
        ? infrastructure
          ? output
          : found
              .map((d) => `${claim.page}:${String(claim.line + d.line)}: ${d.message}`)
              .join('\n')
        : undefined,
    };
  });
}

/**
 * Everything that needs a machine (the container or this computer): the run claims, the compile
 * claims, the `aw` rows.
 *
 * @param {ReturnType<typeof parseArguments>} options @param {readonly Claim[]} claims
 * @param {string} work @param {string} logs
 * @param {(rows: readonly Row[]) => void} partial called with the rows so far after every page
 * @returns {Promise<Row[]>}
 */
async function machineRows(options, claims, work, logs, partial) {
  const prepareMs = positiveIntegerVariable('JOURNEY_PREPARE_TIMEOUT_MS', 10 * 60_000);
  const deadline = Date.now() + prepareMs;
  const port = positiveIntegerVariable('JOURNEY_REGISTRY_PORT', 4873, { max: 65_535 });
  const suffix = randomBytes(4).toString('hex');
  const registry = `docs-claims-registry-${suffix}`;
  const machineName = `docs-claims-machine-${suffix}`;
  const secrets = mkdtempSync(path.join(tmpdir(), 'docs-claims-secrets-'));
  const registryUrl = options.registry ?? `http://127.0.0.1:${String(port)}/`;
  /** @type {{ port: number, close: () => void } | undefined} */
  let fake;
  try {
    if (options.registry === null) {
      say(`== starting Verdaccio on ${registryUrl}`);
      await startRegistry(registry, port, deadline);
      say('== packing and publishing the eight @indx-workspace packages');
      await publishPackages(work, secrets, registryUrl, deadline);
    } else {
      say(`== installing from ${registryUrl}`);
    }
    /** @type {Record<string, string>} */
    let model;
    // A live model without a key is a skipped model, not a stopped run: the rows say so.
    const modelMissing = options.live && options.apiKey === '';
    if (options.live) {
      model = modelMissing ? {} : { ANTHROPIC_API_KEY: options.apiKey };
    } else {
      const key = `${FAKE_KEY_PREFIX}${randomBytes(16).toString('hex')}`;
      SECRETS.add(key);
      fake = await startFakeProvider([], [], []);
      model = {
        ANTHROPIC_API_KEY: key,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${String(fake.port)}`,
      };
    }
    const env = { CI: 'true', ...model };
    const commandMs = positiveIntegerVariable(COMMAND_VARIABLE, COMMAND_TIMEOUT_MS);
    /** @type {Machine} */
    let machine;
    if (options.machine === 'host') {
      say(`== using this computer (${process.platform}), shell ${options.shell}`);
      machine = createHostMachine({
        shell: /** @type {'sh' | 'bash' | 'pwsh'} */ (options.shell),
        work,
        registry: registryUrl,
        env,
        commandMs,
        logs,
      });
      await machine.mkdir(machine.claims);
      const installed = await machine.exec("npm install --global '@indx-workspace/aw'", {
        cwd: machine.claims,
        timeoutMs: commandMs,
      });
      if (installed.status !== 0) {
        throw new JourneyFailure(
          `npm install --global @indx-workspace/aw failed\n${installed.output}`,
        );
      }
    } else {
      say('== starting the clean machine');
      await startMachine(machineName, registryUrl, deadline);
      machine = containerMachine(machineName, env, commandMs, logs);
      await execOk(machineName, shell('npm install --global @indx-workspace/aw'), {
        timeoutMs: commandMs,
        quiet: true,
      });
    }

    // Only on the journey's own machine, registry and model is the first-hour leg the same proof.
    const owned =
      options.machine === 'container' && options.registry === null && !options.live
        ? quickstartCommands(readRepositoryFile(QUICKSTART_PAGE) ?? '')
        : [];
    /** @type {Row[]} */
    const rows = [];
    /** @type {Map<string, Row[]>} */
    const done = new Map();
    for (const plan of runPlans(claims)) {
      const pageRows = ownedRows(plan, owned) ?? (await runPage(machine, plan, done, modelMissing));
      done.set(plan.page, pageRows);
      rows.push(...pageRows);
      partial(rows);
    }
    rows.push(...(await personRows(machine)));
    rows.push(...(await compileRows(machine, claims, work)));
    return rows;
  } finally {
    rmSync(secrets, { recursive: true, force: true });
    removeContainer(machineName);
    removeContainer(registry);
    fake?.close();
  }
}

/**
 * Writes `summary.md` and `results.json`. If either write fails (a full disk, #1098), both files are
 * removed so the report reads the lane as missing, never as a truncated set that looks like a pass.
 *
 * @param {readonly Row[]} rows @param {string[]} notes @param {string} work
 */
export function save(rows, notes, work) {
  const markdown = summaryMarkdown(rows, notes);
  const files = /** @type {const} */ ([
    ['summary.md', markdown],
    ['results.json', `${JSON.stringify(rows, null, 2)}\n`],
  ]);
  for (const [name, text] of files) {
    try {
      writeFileSync(path.join(work, name), text);
    } catch (error) {
      for (const [written] of files) {
        rmSync(path.join(work, written), { recursive: true, force: true });
      }
      throw new JourneyFailure(
        `could not write ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return markdown;
}

/** @param {Row[]} rows @param {string[]} notes @param {string} work */
function report(rows, notes, work) {
  const markdown = save(rows, notes, work);
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') appendFileSync(summary, `${markdown}\n`);
  console.log(markdown.split('\n').slice(0, 3).join('\n'));
}

async function main() {
  const options = parseArguments(process.argv.slice(2), process.env);
  if (options.apiKey !== '') SECRETS.add(options.apiKey);
  delete process.env['ANTHROPIC_API_KEY'];
  const work = path.resolve(
    workDirectoryOf(process.env['DOCS_CLAIMS_WORK_DIR']) ??
      mkdtempSync(path.join(tmpdir(), 'docs-claims-')),
  );
  const logs = path.join(work, 'logs');
  mkdirSync(logs, { recursive: true });
  const { SETUP_QUESTIONS } = await import('@indx-workspace/contracts/setup');
  const claims = extractRepositoryClaims(ROOT);
  const rows = staticRows(
    claims,
    SETUP_QUESTIONS.map((question) => question.flag),
  );
  /** @type {string[]} */
  const notes = [
    `Packages from ${options.registry ?? 'this checkout, in a throwaway Verdaccio'}; model: ${options.live ? 'live' : 'fake'}; machine: ${options.machine === 'host' ? `this computer (${process.platform}), shell ${options.shell}` : 'the journey container'}. Compile rows share one \`tsc\` run, so their duration is its share.`,
    'Run claims execute with `NPM_CONFIG_PREFIX=$HOME/.npm-global` and its `bin` on `PATH`, so a global `npm install` needs no `sudo`; on a default Node install it may fail with EACCES.',
  ];
  if (options.live && options.apiKey === '') {
    notes.push(
      "`ANTHROPIC_API_KEY` is not set: every row from a page's first `npm run dev` on is `skipped`, and a skipped row fails the run; it is never a pass.",
    );
  }
  /** @type {readonly Row[]} */
  let seen = [];
  let written = true;
  try {
    if (options.staticOnly) {
      notes.push('Static only (`--static`): no run or compile claim was executed.');
    } else {
      // Rewritten after every page, so a step timeout keeps the rows already produced.
      const partial = (/** @type {readonly Row[]} */ done) => {
        seen = done;
        save([...rows, ...done], notes, work);
      };
      rows.push(...(await machineRows(options, claims, work, logs, partial)));
    }
  } catch (error) {
    rows.push(...seen, {
      where: 'tests/docs-claims/run.mjs',
      state: 'run',
      what: 'the clean machine',
      result: 'FAIL: the run stopped before every claim ran',
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      report(rows, notes, work);
    } catch (error) {
      console.error(
        `docs claims: ${scrub(error instanceof Error ? error.message : String(error))}; the results are incomplete`,
      );
      written = false;
    }
  }
  process.exitCode = written ? exitCodeOf(rows) : 1;
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
