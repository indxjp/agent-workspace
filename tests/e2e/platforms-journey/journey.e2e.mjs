#!/usr/bin/env node
/* global console */
/**
 * The platforms journey (issue #979): a fresh developer goes from `npm create` to `aw platforms
 * export` for every agent platform, and each export's verdict list is compared with a committed
 * golden, so a dropped or re-mapped field never changes silently.
 *
 *   pnpm build && node tests/e2e/platforms-journey/journey.e2e.mjs
 *
 * 1. Publish the packed `@indx-workspace` packages to a throwaway Verdaccio.
 * 2. `npm create @indx-workspace@latest demo -- --yes --theme support --platform claude-managed-agents`.
 * 3. Add the code tool, a Claude model, and every platform with the options it needs to export
 *    (`PLATFORM_OPTIONS`: placeholders, none a credential).
 * 4. `aw platforms export` to each id and compare with `golden/<id>.json`; three refusals; `doctor`;
 *    the round trip through `aw platforms import`.
 *
 * It needs Docker (Verdaccio) and `npm`; no model key and no vendor CLI. Environment: `PJ_WORK_DIR`
 * (default: a new temporary directory), `PJ_NPM_PORT` (4874), `PJ_PREPARE_TIMEOUT_MS` (15 minutes:
 * the cap on packing and publishing) and `PJ_WRITE_GOLDEN=1` (rewrite the goldens instead of
 * comparing). It shares Verdaccio's container name with the build-to-deploy journey, so the two
 * must not run on one Docker daemon at the same time.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { positiveIntegerVariable } from '../../generated-project/run.mjs';
import { JourneyFailure } from '../../journey/harness.mjs';
import { scrub } from '../../journey/run.mjs';
import {
  agentWithTool,
  check,
  createSupportProject,
  journeyShell,
  preparePackages,
  stopPackages,
} from '../build-deploy-journey/journey.e2e.mjs';
import { DECLARATION, RUN_FILE } from '../tool-sandbox.e2e.mjs';
import { assertIdSet, compareWithGolden, normaliseVerdicts } from './verdicts.mjs';

const GOLDEN_DIR = path.join(import.meta.dirname, 'golden');
const PREPARE_BUDGET_MS = 15 * 60_000;
const CMA = 'claude-managed-agents';

/** A Claude model reference every target accepts: a hosted target refuses `default` and others. */
export const EXPORT_MODEL = "{ connection: 'default', id: 'claude-sonnet-4-6' }";

/**
 * What each platform needs under `platforms.<id>.options` before it exports (#1072): placeholders
 * that name no real tenant, project or account, and none a credential. A platform not listed needs
 * no options.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const PLATFORM_OPTIONS = {
  'copilot-studio': { publisherPrefix: 'demo' },
  'microsoft-foundry': { modelDeployment: 'demo-deployment' },
  'gemini-enterprise': {
    projectId: 'demo-project',
    location: 'global',
    engineId: 'demo-engine',
    publicBaseUrl: 'https://agents.example.com',
  },
  'aws-agentcore': { region: 'us-east-1', accountId: '123456789012' },
};

/**
 * The `platforms:` block of `agent-workspace.yaml` enabling `ids`, each with its `PLATFORM_OPTIONS`.
 * Values are JSON strings, which are YAML double-quoted scalars (an account id stays a string).
 *
 * @param {readonly string[]} ids
 */
export function platformsBlock(ids) {
  const entries = ids.map((id) => {
    const options = Object.entries(PLATFORM_OPTIONS[id] ?? {});
    return [
      `  ${id}:`,
      '    enabled: true',
      ...(options.length === 0
        ? []
        : [
            '    options:',
            ...options.map(([key, value]) => `      ${key}: ${JSON.stringify(value)}`),
          ]),
    ].join('\n');
  });
  return `platforms:\n${entries.join('\n')}\n`;
}

/**
 * `yaml` with its `platforms:` block (the one `npm create --platform` wrote) replaced by `ids`; the
 * journey stops when the block moved, which also proves the setup wrote it.
 *
 * @param {string} yaml @param {readonly string[]} ids
 */
export function withPlatforms(yaml, ids) {
  const block = /^platforms:\n(?: {2,}.*\n?)+/mu;
  if (!block.test(yaml)) throw new JourneyFailure('agent-workspace.yaml has no platforms: block');
  return yaml.replace(block, platformsBlock(ids));
}

/** @param {string} text the text after the front matter of an agent file */
function bodyOf(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim();
}

/**
 * `aw` of one project: the exit code, stdout and stderr of each call, appended (scrubbed of the run's
 * secrets) to the evidence. A call runs in `env`, `userEnv` unless given.
 *
 * @param {{ project: string, userEnv: NodeJS.ProcessEnv, evidence: string }} options
 */
export function awOf({ project, userEnv, evidence }) {
  mkdirSync(evidence, { recursive: true });
  return (/** @type {readonly string[]} */ args, env = userEnv) => {
    const result = spawnSync(path.join(project, 'node_modules/.bin/aw'), [...args], {
      cwd: project,
      env,
      encoding: 'utf8',
      shell: false,
      timeout: 600_000,
    });
    const outcome = {
      status: result.status,
      stdout: scrub(String(result.stdout)),
      stderr: scrub(String(result.stderr)),
    };
    appendFileSync(
      path.join(evidence, 'commands.log'),
      `$ aw ${args.join(' ')}\nexit ${String(result.status ?? result.signal)}\n--- stdout\n${outcome.stdout}\n--- stderr\n${outcome.stderr}\n\n`,
    );
    return outcome;
  };
}

/**
 * Copies the `exported` bundle to `importDir` with its agent `from` renamed to `to` (the front matter
 * `name:` and the file `agents/<name>.md`), ready for `aw platforms import`; returns the original text.
 *
 * @param {{ exported: string, importDir: string, from: string, to: string }} options
 */
export function renameExportedAgent({ exported, importDir, from, to }) {
  cpSync(exported, importDir, { recursive: true });
  const original = path.join(importDir, 'agents', `${from}.md`);
  check(existsSync(original), `the ${CMA} export wrote agents/${from}.md`);
  const front = new RegExp(`^name: ${from}$`, 'mu');
  const text = readFileSync(original, 'utf8');
  if (!front.test(text)) throw new JourneyFailure(`${original} has no name: ${from} line`);
  writeFileSync(path.join(importDir, 'agents', `${to}.md`), text.replace(front, `name: ${to}`));
  rmSync(original);
  return text;
}

/** @param {string} text @param {string} what */
function parseJson(text, what) {
  try {
    return /** @type {unknown} */ (JSON.parse(text));
  } catch {
    throw new JourneyFailure(`${what} did not print JSON:\n${text}`);
  }
}

/** The golden ids: `golden/<id>.json` file names. */
function goldenIds() {
  return readdirSync(GOLDEN_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

/**
 * Exports to every id and compares with its golden; returns every difference found so one run shows
 * all drift. The normalised verdicts of each id are also written to `evidence/verdicts/<id>.json`.
 *
 * @param {{ ids: readonly string[], aw: ReturnType<typeof awOf>, out: string, evidence: string, writeGolden: boolean }} options
 */
function exportEverywhere({ ids, aw, out, evidence, writeGolden }) {
  /** @type {string[]} */
  const problems = [];
  mkdirSync(path.join(evidence, 'verdicts'), { recursive: true });
  for (const id of ids) {
    const directory = path.join(out, id);
    const run = aw(['platforms', 'export', '--platform', id, '--out', directory, '--json']);
    if (run.status !== 0) {
      problems.push(`${id}: aw platforms export exited ${String(run.status)}\n${run.stderr}`);
      continue;
    }
    const result = parseJson(run.stdout, `aw platforms export --platform ${id}`);
    const report =
      typeof result === 'object' && result !== null ? Reflect.get(result, 'report') : null;
    const files =
      typeof result === 'object' && result !== null ? Reflect.get(result, 'files') : null;
    if (!existsSync(path.join(directory, 'PLATFORM_REPORT.md'))) {
      problems.push(`${id}: PLATFORM_REPORT.md was not written`);
    }
    if (!Array.isArray(files) || files.length < 2) {
      problems.push(`${id}: the export wrote no file besides PLATFORM_REPORT.md`);
    }
    const actual = normaliseVerdicts(report);
    const text = `${JSON.stringify(actual, null, 2)}\n`;
    writeFileSync(path.join(evidence, 'verdicts', `${id}.json`), text);
    if (writeGolden) {
      writeFileSync(path.join(GOLDEN_DIR, `${id}.json`), text);
      continue;
    }
    const golden = normaliseVerdicts(
      JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${id}.json`), 'utf8')),
    );
    for (const difference of compareWithGolden(actual, golden)) {
      problems.push(`${id}: ${difference}`);
    }
  }
  return problems;
}

async function main() {
  const work = path.resolve(
    process.env['PJ_WORK_DIR'] ?? mkdtempSync(path.join(tmpdir(), 'platforms-journey-')),
  );
  const npmPort = positiveIntegerVariable('PJ_NPM_PORT', 4874, { max: 65_535 });
  const deadline = Date.now() + positiveIntegerVariable('PJ_PREPARE_TIMEOUT_MS', PREPARE_BUDGET_MS);
  const writeGolden = process.env['PJ_WRITE_GOLDEN'] === '1';
  const { npmUrl, evidence, userEnv } = journeyShell({ work, npmPort });
  const out = path.join(work, 'out');

  try {
    await preparePackages({ work, npmPort, npmUrl, deadline });

    const created = createSupportProject({
      work,
      name: 'demo',
      userEnv,
      extraArgs: ['--platform', CMA],
    });
    const { project, agentPath, rendered, agentName } = created;
    const aw = awOf({ project, userEnv, evidence });
    const yamlPath = path.join(project, 'agent-workspace.yaml');
    const yaml = readFileSync(yamlPath, 'utf8');
    check(
      new RegExp(`^platforms:\\n(?: {2}.*\\n)*? {2}${CMA}:`, 'mu').test(yaml),
      `npm create --platform wrote platforms: ${CMA}`,
    );
    check(existsSync(agentPath), 'npm create wrote the TypeScript agent');
    check(
      !readdirSync(path.join(project, 'agents')).some((name) => name.endsWith('.agent.md')),
      'npm create wrote no .agent.md',
    );

    console.log('== the platform list');
    const listed = parseJson(aw(['platforms', 'list', '--json']).stdout, 'aw platforms list');
    if (!Array.isArray(listed)) throw new JourneyFailure('aw platforms list did not print a list');
    const ids = listed.map((entry) => String(Reflect.get(Object(entry), 'id'))).sort();
    check(ids.length > 0, `aw platforms list names ${String(ids.length)} platforms`);
    if (!writeGolden) assertIdSet(ids, goldenIds());

    console.log('== a code tool, a Claude model and every platform with its required options');
    mkdirSync(path.join(project, 'tools'), { recursive: true });
    writeFileSync(path.join(project, 'tools/get-order.ts'), DECLARATION);
    writeFileSync(path.join(project, 'tools/get-order.run.ts'), RUN_FILE);
    writeFileSync(agentPath, agentWithTool(rendered, EXPORT_MODEL));
    writeFileSync(yamlPath, withPlatforms(yaml, ids));

    console.log('== aw platforms export, every platform');
    const problems = exportEverywhere({ ids, aw, out, evidence, writeGolden });
    if (problems.length > 0) {
      throw new JourneyFailure(
        `${String(problems.length)} export problems (golden/ is rewritten with PJ_WRITE_GOLDEN=1):\n${problems.join('\n')}`,
      );
    }
    check(true, `${String(ids.length)} exports match their goldens`);

    console.log('== refusals');
    const strict = aw([
      'platforms',
      'export',
      '--platform',
      CMA,
      '--strict',
      '--out',
      path.join(out, 'strict'),
    ]);
    check(strict.status === 5, '--strict with a dropped field exits 5');
    check(
      strict.stderr.includes(`fields dropped for ${CMA}`),
      '--strict names the platform whose fields were dropped',
    );

    const foreign = path.join(work, 'demo-foreign-model');
    cpSync(project, foreign, { recursive: true, verbatimSymlinks: true });
    const foreignAgent = path.join(foreign, path.relative(project, agentPath));
    const claudeId = "id: 'claude-sonnet-4-6'";
    const source = readFileSync(foreignAgent, 'utf8');
    if (!source.includes(claudeId)) throw new JourneyFailure(`the agent file has no ${claudeId}`);
    writeFileSync(foreignAgent, source.replace(claudeId, "id: 'openai/gpt-5'"));
    const refused = awOf({ project: foreign, userEnv, evidence })([
      'platforms',
      'export',
      '--platform',
      CMA,
      '--out',
      path.join(out, 'foreign-model'),
    ]);
    check(refused.status === 1, 'a non-Claude model for claude-managed-agents exits 1');
    check(
      refused.stderr.includes('error: platform_model_unsupported'),
      'the refusal carries platform_model_unsupported',
    );

    const unknown = aw(['platforms', 'export', '--platform', 'not-a-platform']);
    check(unknown.status === 2, 'an unknown platform exits 2');

    console.log('== aw platforms doctor');
    // Before the import: with two agents in the project, doctor needs --agent for every row.
    const doctor = aw(['platforms', 'doctor', '--json']);
    check(doctor.status === 0, 'aw platforms doctor exits 0 (vendor CLIs may be absent)');
    const rows = parseJson(doctor.stdout, 'aw platforms doctor');
    const subjects = new Set(
      (Array.isArray(rows) ? rows : [])
        .filter((row) => Reflect.get(Object(row), 'check') === 'compile')
        .map((row) => String(Reflect.get(Object(row), 'subject'))),
    );
    check(
      ids.every((id) => subjects.has(id)),
      'aw platforms doctor reports a compile row for every platform',
    );

    console.log('== round trip: export, import as .agent.md, export again');
    const imported = `${agentName}-imported`;
    const exported = path.join(out, CMA);
    const importDir = path.join(work, 'cma-import');
    const text = renameExportedAgent({
      exported,
      importDir,
      from: agentName,
      to: imported,
    });

    // The export copied the project's skills; without them the importer drops the skill
    // reference, so keep them and overwrite the project's files with the same bytes.
    const skill = path.join(project, 'skills', 'refund-policy', 'SKILL.md');
    const skillBefore = readFileSync(skill, 'utf8');
    const imports = aw(['platforms', 'import', '--from', CMA, importDir, '--yes']);
    check(!imports.stderr.includes('already exist'), 'aw platforms import overwrites with --yes');
    check(imports.status === 0, `aw platforms import --from ${CMA} exits 0`);
    check(
      readFileSync(skill, 'utf8') === skillBefore,
      'the import rewrites skills/refund-policy/SKILL.md with the same bytes',
    );
    check(
      existsSync(path.join(project, 'agents', `${imported}.agent.md`)),
      `aw platforms import wrote agents/${imported}.agent.md`,
    );
    const again = aw([
      'platforms',
      'export',
      '--platform',
      CMA,
      '--agent',
      imported,
      '--out',
      path.join(out, 'roundtrip'),
    ]);
    check(again.status === 0, 'the imported agent exports again with exit 0');
    check(
      bodyOf(readFileSync(path.join(out, 'roundtrip', 'agents', `${imported}.md`), 'utf8')) ===
        bodyOf(text),
      'the round trip keeps the instructions',
    );
  } finally {
    stopPackages();
    if (existsSync(out)) cpSync(out, path.join(evidence, 'out'), { recursive: true });
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
