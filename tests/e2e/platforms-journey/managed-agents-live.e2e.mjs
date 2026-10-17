#!/usr/bin/env node
/* global console, fetch, AbortSignal, URL */
/**
 * The live Managed Agents lane (issue #979): publishes the platforms journey's agent to Claude
 * Managed Agents with the real `ant` CLI, reads it back, and removes it again. It creates real
 * resources, so it runs on `workflow_dispatch` only (`platforms-live-managed-agents` in
 * `.github/workflows/journey-live.yml`), never on a pull request or a schedule.
 *
 *   ANTHROPIC_API_KEY=… PJ_LIVE_RUN_ID=<digits> node tests/e2e/platforms-journey/managed-agents-live.e2e.mjs
 *
 * Needs Docker (Verdaccio), npm and `ant` >= 1.30.0 on PATH. Without `ANTHROPIC_API_KEY` it exits 1:
 * skipped is not a pass (the rule of tests/docs-claims/run.mjs). Environment: `PJ_LIVE_RUN_ID`
 * (required, digits: the workflow passes the run id; the agent is named `awpt-<run id>`),
 * `PJ_WORK_DIR`, `PJ_NPM_PORT` (4874) and `PJ_PREPARE_TIMEOUT_MS` as in `journey.e2e.mjs`.
 *
 * 1. The journey's project and its Managed Agents export, the agent renamed to `awpt-<run id>` and
 *    imported as `agents/awpt-<run id>.agent.md` (no code tool, so nothing is dropped).
 * 2. `aw platforms publish` without `--yes`: exit 3 and a plan naming the agent; nothing created.
 * 3. The same with `--yes`: exit 0; the Managed Agents list shows the agent, and its id is the
 *    one in `claude-lock.json`.
 * 4. Always, also on SIGINT/SIGTERM: archive every agent, delete every skill and then every
 *    environment the lock file records (and archive every active agent named exactly
 *    `awpt-<run id>`); an unknown kind fails, naming its kind and id. List agents and environments
 *    again; a leftover fails.
 *
 * The key is read from the environment only, added to `SECRETS` before any command, handed to the
 * `aw publish` and `ant` children through their environment (never an argument), and every line this
 * script prints or writes goes through `scrub`.
 *
 * Every step logs an `== <step>` header, and a failure logs `FAILED at step "…"` before the cleanup.
 * A list response that does not parse is reported by its top-level key names only.
 *
 * VERIFY (each read against the official page; the list shape, with `next_page` an optional string
 * or null, is committed as `fixtures/agents-list.json` and tested in `verdicts.test.ts`):
 * - install:  https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart
 * - apply:    https://platform.claude.com/docs/en/cli-sdks-libraries/cli/apply
 * - overview (beta header `managed-agents-2026-04-01`):
 *             https://platform.claude.com/docs/en/managed-agents/overview
 * - list:     https://platform.claude.com/docs/en/api/beta/agents/list  (GET /v1/agents)
 * - archive:  https://platform.claude.com/docs/en/api/cli/beta/agents/archive
 *             (`ant beta:agents archive --agent-id <id>`)
 * - skills:   https://platform.claude.com/docs/en/api/cli/beta/skills/delete
 *             (`ant beta:skills delete --skill-id <id>`)
 * - environments (read 2026-10-13, not yet confirmed by a dispatch; `cleanupPlan` in verdicts.mjs):
 *             https://platform.claude.com/docs/en/api/cli/beta/environments/delete
 *             (`ant beta:environments delete --environment-id <id>`) and
 *             https://platform.claude.com/docs/en/api/beta/environments/list
 *             (GET /v1/environments, active only unless `include_archived`)
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { positiveIntegerVariable } from '../../generated-project/run.mjs';
import { JourneyFailure } from '../../journey/harness.mjs';
import { SECRETS, say, scrub } from '../../journey/run.mjs';
import {
  check,
  createSupportProject,
  journeyShell,
  preparePackages,
  stopPackages,
} from '../build-deploy-journey/journey.e2e.mjs';
import { EXPORT_MODEL, awOf, renameExportedAgent, withPlatforms } from './journey.e2e.mjs';
import { agentsPage, cleanupPlan, findAgentByName, lockResources } from './verdicts.mjs';

const CMA = 'claude-managed-agents';
const PREPARE_BUDGET_MS = 15 * 60_000;
const API = 'https://api.anthropic.com';
const LOCK_FILE = 'claude-lock.json';

/**
 * The name of the agent a run publishes; the run id must be digits so a name never matches the
 * prefix of another run's.
 *
 * @param {string | undefined} runId
 */
export function liveAgentName(runId) {
  if (runId === undefined || !/^\d+$/u.test(runId)) {
    throw new JourneyFailure('PJ_LIVE_RUN_ID is required and must be digits (the workflow run id)');
  }
  return `awpt-${runId}`;
}

/**
 * @param {string} key
 * @param {'agents' | 'environments'} resource every page of the active list (`GET /v1/<resource>`,
 *   100 per page)
 */
async function listPages(key, resource) {
  /** @type {unknown[]} */
  const pages = [];
  /** @type {string | null} */
  let cursor = null;
  do {
    const url = new URL(`/v1/${resource}`, API);
    url.searchParams.set('limit', '100');
    if (cursor !== null) url.searchParams.set('page', cursor);
    const response = await fetch(url, {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'managed-agents-2026-04-01',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new JourneyFailure(`GET /v1/${resource} answered ${String(response.status)}`);
    const page = /** @type {unknown} */ (await response.json());
    pages.push(page);
    cursor = agentsPage(page, resource).nextPage;
  } while (cursor !== null);
  return pages;
}

/** @param {unknown[]} pages @param {string} name */
function activeNamed(pages, name) {
  return pages
    .flatMap((page) => agentsPage(page).agents)
    .filter((agent) => agent.name === name && !agent.archived);
}

async function main() {
  const key = (process.env['ANTHROPIC_API_KEY'] ?? '').trim();
  if (key === '') {
    console.error(
      'ANTHROPIC_API_KEY is not set: the live Managed Agents lane did not run, and skipped is not a pass',
    );
    process.exitCode = 1;
    return;
  }
  SECRETS.add(key);
  const name = liveAgentName(process.env['PJ_LIVE_RUN_ID']);

  const work = path.resolve(
    process.env['PJ_WORK_DIR'] ?? mkdtempSync(path.join(tmpdir(), 'platforms-live-')),
  );
  const npmPort = positiveIntegerVariable('PJ_NPM_PORT', 4874, { max: 65_535 });
  const deadline = Date.now() + positiveIntegerVariable('PJ_PREPARE_TIMEOUT_MS', PREPARE_BUDGET_MS);
  const { npmUrl, evidence, userEnv } = journeyShell({ work, npmPort });
  const liveEnv = { ...userEnv, ANTHROPIC_API_KEY: key };
  const out = path.join(work, 'out');
  const publishDir = path.join(work, 'publish');

  /** @param {readonly string[]} args */
  const ant = (args) => {
    const result = spawnSync('ant', [...args], {
      env: liveEnv,
      encoding: 'utf8',
      shell: false,
      timeout: 120_000,
    });
    const text = scrub(`${String(result.stdout)}${String(result.stderr)}`);
    appendFileSync(
      path.join(evidence, 'commands.log'),
      `$ ant ${args.join(' ')}\nexit ${String(result.status ?? result.signal)}\n${text}\n\n`,
    );
    return { ok: result.status === 0, text };
  };

  /** @type {Promise<string[]> | undefined} */
  let cleaned;
  /** The problems cleanup found; empty when the account holds nothing of this run. */
  const cleanup = () => {
    cleaned ??= removeEverything();
    return cleaned;
  };

  async function removeEverything() {
    /** @type {string[]} */
    const problems = [];
    /** @type {import('./verdicts.d.mts').LockResources} */
    let recorded = { agents: [], skills: [], environments: [], other: [] };
    const lock = path.join(publishDir, LOCK_FILE);
    if (existsSync(lock)) {
      try {
        recorded = lockResources(readFileSync(lock, 'utf8'));
      } catch (error) {
        problems.push(`unreadable ${LOCK_FILE}: ${error instanceof Error ? error.message : ''}`);
      }
    }
    const agents = new Set(recorded.agents);
    try {
      for (const agent of activeNamed(await listPages(key, 'agents'), name)) agents.add(agent.id);
    } catch (error) {
      problems.push(`listing agents failed: ${error instanceof Error ? error.message : ''}`);
    }
    const plan = cleanupPlan({ ...recorded, agents: [...agents] });
    problems.push(...plan.problems);
    for (const command of plan.commands) {
      if (!ant(command).ok)
        problems.push(`${command[1] ?? 'remove'} ${command.at(-1) ?? ''} failed`);
    }
    try {
      const left = activeNamed(await listPages(key, 'agents'), name);
      if (left.length > 0)
        problems.push(`left behind: ${left.map((agent) => agent.id).join(', ')}`);
    } catch (error) {
      problems.push(`listing agents failed: ${error instanceof Error ? error.message : ''}`);
    }
    if (recorded.environments.length > 0) {
      try {
        const recordedIds = new Set(recorded.environments);
        const left = (await listPages(key, 'environments'))
          .flatMap((page) => agentsPage(page, 'environments').agents)
          .filter((environment) => recordedIds.has(environment.id) && !environment.archived);
        if (left.length > 0)
          problems.push(
            `left behind environment: ${left.map((environment) => environment.id).join(', ')}`,
          );
      } catch (error) {
        problems.push(
          `listing environments failed: ${error instanceof Error ? error.message : ''}`,
        );
      }
    }
    return problems;
  }

  // ponytail: spawnSync holds the event loop, so a signal is handled once the running child ends.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void cleanup().then((problems) => {
        stopPackages();
        say(`${signal}: cleanup ${problems.length === 0 ? 'done' : problems.join('; ')}`);
        process.exit(1);
      });
    });
  }

  let current = 'start';
  /** @param {string} title */
  const step = (title) => {
    current = title;
    say(`== ${title}`);
  };

  /** @type {unknown} */
  let failure;
  try {
    step('prepare packages and the support project');
    await preparePackages({ work, npmPort, npmUrl, deadline });
    const created = createSupportProject({
      work,
      name: 'demo',
      userEnv,
      extraArgs: ['--platform', CMA],
    });
    const { project, agentPath, rendered, agentName } = created;
    const aw = awOf({ project, userEnv, evidence });

    // The code tool is left out on purpose: nothing may be dropped on the way to the platform.
    const anchor = /^ {2}model: 'default',$/mu;
    if (!anchor.test(rendered)) throw new JourneyFailure(`the agent file has no ${String(anchor)}`);
    writeFileSync(agentPath, rendered.replace(anchor, `  model: ${EXPORT_MODEL},`));
    const yamlPath = path.join(project, 'agent-workspace.yaml');
    writeFileSync(yamlPath, withPlatforms(readFileSync(yamlPath, 'utf8'), [CMA]));

    step('export, rename to the run agent, import as .agent.md');
    const exported = path.join(out, CMA);
    const exportRun = aw(['platforms', 'export', '--platform', CMA, '--out', exported]);
    check(exportRun.status === 0, `aw platforms export --platform ${CMA} exits 0`);
    renameExportedAgent({
      exported,
      importDir: path.join(work, 'cma-import'),
      from: agentName,
      to: name,
    });
    const imported = aw([
      'platforms',
      'import',
      '--from',
      CMA,
      path.join(work, 'cma-import'),
      '--yes',
    ]);
    check(imported.status === 0, `aw platforms import --from ${CMA} exits 0`);
    check(
      existsSync(path.join(project, 'agents', `${name}.agent.md`)),
      `aw platforms import wrote agents/${name}.agent.md`,
    );

    step('publish without --yes: a plan, nothing created');
    const publish = [
      'platforms',
      'publish',
      '--platform',
      CMA,
      '--agent',
      name,
      '--out',
      publishDir,
    ];
    const plan = aw(publish, liveEnv);
    check(plan.status === 3, 'publish without --yes exits 3 (changes are pending)');
    check(`${plan.stdout}\n${plan.stderr}`.includes(name), `the plan names ${name}`);
    step(`list agents after the plan: none named ${name}`);
    check(
      findAgentByNameOnAllPages(await listPages(key, 'agents'), name) === undefined,
      `no active agent ${name} exists after the plan`,
    );

    step('publish with --yes');
    const applied = aw([...publish, '--yes'], liveEnv);
    check(applied.status === 0, 'publish --yes exits 0');
    const lock = path.join(publishDir, LOCK_FILE);
    check(existsSync(lock), `${LOCK_FILE} was written`);

    step('read back from the Managed Agents list');
    const listed = findAgentByNameOnAllPages(await listPages(key, 'agents'), name);
    check(listed !== undefined, `the Managed Agents list shows ${name}`);
    check(
      lockResources(readFileSync(lock, 'utf8')).agents.includes(listed?.id ?? ''),
      `the id of ${name} in the list is the one in ${LOCK_FILE}`,
    );
  } catch (error) {
    failure = error;
    say(`FAILED at step "${current}": ${error instanceof Error ? error.message : String(error)}`);
  }

  step('cleanup');
  const problems = await cleanup();
  stopPackages();
  if (existsSync(out)) cpSync(out, path.join(evidence, 'out'), { recursive: true });
  if (problems.length > 0) {
    console.error(scrub(`cleanup problems:\n${problems.join('\n')}`));
    process.exitCode = 1;
  }
  if (failure !== undefined) throw failure;
  say(`ok: ${name} was published, read back and removed`);
}

/** @param {unknown[]} pages @param {string} name */
function findAgentByNameOnAllPages(pages, name) {
  for (const page of pages) {
    const found = findAgentByName(page, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(scrub(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
