#!/usr/bin/env node
/* global console */
/**
 * The ten use cases of the landing page (`tests/gallery/<id>/`), run with the published `aw`,
 * `@indx-workspace/sdk` and `@indx-workspace/embedded` (what `npm create` pins) from a real
 * registry and the real model (issue #881, the `install-live` workflow). For each project: its own
 * MCP servers and stand-in APIs (the `#   ...` lines of its `agent-workspace.yaml`), then `aw dev`
 * until it is ready, signed in and has made its first sync, the workspace secrets that sign its
 * caller assertions (added in the console as the Owner, as the project file says, since `aw dev`
 * holds an Admin key; with the value its servers verify with), the
 * folders its agents are granted (`aw files mkdir`, then `aw files upload` of `data/<folder>/`),
 * the skill revisions its agents pin (`aw skills publish`), `aw push --yes`, a restart of each server that verifies the caller assertion with the connector
 * id and workspace id `aw connectors list` now names (the project file's `<tool-id>` and
 * `<workspace-id>`), `aw check`, one
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
import { randomBytes } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';

import { positiveIntegerVariable } from '../generated-project/run.mjs';
import { JourneyFailure, registryOf, workDirectoryOf } from '../journey/harness.mjs';
import { SECRETS, say, scrub } from '../journey/run.mjs';
import { createHostMachine } from './host.mjs';
import { exitCodeOf, summaryMarkdown } from './run.mjs';
import { projectRows } from './use-cases-project.mjs';

export {
  MAX_TRACED_RUNS,
  STAND_IN,
  chatFailedRunId,
  chatPausedRunId,
  devEnvironment,
  failedRuns,
  firstPrompt,
  identityEnvironment,
  identityTargets,
  printedRun,
  serverCommands,
  workspaceSecrets,
} from './use-cases-parse.mjs';
export {
  fileSetupCommands,
  pointApisAtLoopback,
  skillPublishCommands,
} from './use-cases-server.mjs';
export { consoleSignIn, signInFormFields } from './use-cases-console.mjs';

/** @typedef {import('./run.mjs').Row} Row */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

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

/** @param {Row[]} rows @param {string[]} notes @param {string} work */
function saveSummary(rows, notes, work) {
  const markdown = summaryMarkdown(rows, notes, 'Use cases');
  writeFileSync(path.join(work, 'summary.md'), markdown);
  writeFileSync(path.join(work, 'results.json'), `${JSON.stringify(rows, null, 2)}\n`);
  return markdown;
}

/** @param {string} gallery the work directory's copy of the gallery */
function copyGallery(gallery) {
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
}

/**
 * @param {ReturnType<typeof createHostMachine>} machine
 * @param {{ gallery: string, logs: string, version: string }} where
 * @param {Row[]} rows
 */
async function installPackages(machine, { gallery, logs, version }, rows) {
  const started = performance.now();
  for (const [what, command] of installSteps(version)) {
    say(`== ${what}`);
    const installed = await machine.exec(command, { cwd: gallery, timeoutMs: machine.commandMs });
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
}

/** @param {string} markdown */
function publishSummary(markdown) {
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '' && existsSync(path.dirname(summary))) {
    appendFileSync(summary, `${markdown}\n`);
  }
  console.log(markdown.split('\n').slice(0, 3).join('\n'));
}

/** @param {{ version: string, registry: string }} options @param {boolean} hasKey */
function summaryNotes(options, hasKey) {
  const notes = [
    `Packages \`@indx-workspace/aw@${options.version}\`, \`@indx-workspace/sdk@${options.version}\` and \`@indx-workspace/embedded@${options.version}\`, plus the \`claude-agent-sdk\` engine packages at the versions \`@indx-workspace/sdk/project\` pins, from ${options.registry}; model: live. The gallery is this checkout's \`tests/gallery\`; a project passes \`aw eval\` when the command exits 0.`,
    `The gallery and this harness are commit \`${checkoutCommit()}\` of this checkout.`,
  ];
  if (!hasKey) {
    notes.push(
      '`ANTHROPIC_API_KEY` is not set: every use-case row is `skipped`, and a skipped row fails the run; it is never a pass.',
    );
  }
  return notes;
}

/** @returns {string} a random value that is scrubbed from every log */
function newSecret() {
  const value = randomBytes(16).toString('hex');
  SECRETS.add(value);
  return value;
}

/** @returns {{ work: string, logs: string }} */
function prepareWorkDirectory() {
  const work = path.resolve(
    workDirectoryOf(process.env['DOCS_CLAIMS_WORK_DIR']) ??
      mkdtempSync(path.join(tmpdir(), 'use-cases-')),
  );
  const logs = path.join(work, 'logs');
  mkdirSync(logs, { recursive: true });
  return { work, logs };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const apiKey = process.env['ANTHROPIC_API_KEY']?.trim() ?? '';
  if (apiKey !== '') SECRETS.add(apiKey);
  delete process.env['ANTHROPIC_API_KEY'];
  const { work, logs } = prepareWorkDirectory();
  const machine = createHostMachine({
    shell: 'sh',
    work,
    registry: options.registry,
    env: apiKey === '' ? { CI: 'true' } : { CI: 'true', ANTHROPIC_API_KEY: apiKey },
    commandMs: positiveIntegerVariable('DOCS_CLAIMS_COMMAND_TIMEOUT_MS', 5 * 60_000),
    logs,
  });
  /** @type {Row[]} */
  const rows = [];
  const notes = summaryNotes(options, apiKey !== '');
  try {
    const gallery = path.join(work, 'gallery');
    copyGallery(gallery);
    await installPackages(machine, { gallery, logs, version: options.version }, rows);
    for (const id of PROJECTS) {
      say(`== ${id}`);
      const project = { id, dir: path.join(gallery, id), logs };
      rows.push(...(await projectRows(machine, project, { secret: newSecret, apiKey })));
      // Rewritten after every project, so a step timeout keeps the rows already produced.
      saveSummary(rows, notes, work);
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
    publishSummary(saveSummary(rows, notes, work));
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
