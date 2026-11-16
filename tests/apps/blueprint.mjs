/* global console */
/**
 * The apps-e2e lane's app-blueprint scenario (ADR-0166, issue #1533): one part of a reference app,
 * `examples/service-desk`'s ticket with its pages, routes, migration and test and its SLA rule, is
 * published as a fixture blueprint and installed into a fresh copy of `examples/minimal` with
 * `aw blueprint add`. Its installed migrations must then apply (`aw-app migrate` against a
 * throwaway PostgreSQL from the pinned `embedded-postgres`), and the copy must build and pass its
 * own tests and the blueprint's.
 *
 * The fixture is assembled at run time from the service desk's files, never committed as a copy,
 * so it cannot drift from the app it is taken from. Three versions are packed with `npm pack`:
 *
 * - `1.0.0`, which `add` installs;
 * - `1.1.0`, which changes one file ({@link CHANGED_IN_V2}): `update` without `--yes` proposes it,
 *   exits 3 and changes nothing, and with `--yes` applies it;
 * - `2.0.0`, which appends a destructive migration ({@link DESTRUCTIVE_MIGRATION}): `update`
 *   refuses it by name, before anything is written.
 *
 * The updates fetch `<package>@<version>` from npm, so each runs against a loopback registry that
 * serves that one version (`package-server.mjs`). The installed blueprint is then removed with
 * `aw destroy blueprint`. Nothing here needs Docker.
 *
 * Some of the fixture is its own, not the service desk's: the service desk's `recipes/sla-rule.ts`
 * is a module of helpers its `sla-sweep` recipe imports, and a blueprint's `recipe` part is wired
 * into `app.config.ts` as a recipe (ADR-0166 D6), so the fixture appends a read-only recipe
 * ({@link SLA_RECIPE}) to the rule, with a test of it ({@link SLA_RECIPE_TEST}). `sla-sweep.ts`
 * itself cannot travel: it imports `lib/agent-ids.ts`, which no part kind holds (D2), the
 * `ticket_comment` resource, and the desk's `triage` agent, whose run its writes need (ADR-0164).
 * shortcut: the SLA recipe only lists breached tickets; upgrade to escalating them when a fixture
 * blueprint carries an `agents/<name>.agent.md` part whose run the writes can carry.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { createCleanup } from '../../scripts/test-services/cleanup.mjs';
import { startNativePostgres } from '../../scripts/test-services/postgres-native.mjs';
import { spawnPackageServer } from './package-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** The app the fixture's parts are taken from. */
export const SERVICE_DESK = path.join(ROOT, 'examples/service-desk');
const APP_KIT_MANIFEST = path.join(ROOT, 'packages/app/package.json');

/** The blueprint's name: its `blueprint:<name>` entry and the `aw blueprint` argument. */
export const BLUEPRINT_NAME = 'service-desk-ticket';
/** Its npm package name, which the loopback registry serves on update. */
export const BLUEPRINT_PACKAGE = 'service-desk-ticket-blueprint';
/** The keyword every blueprint package carries (ADR-0166 D4). */
export const BLUEPRINT_KEYWORD = 'indx-workspace-blueprint';

/** The versions packed: the one installed, one with a changed file, one with a destructive migration. */
export const FIXTURE_VERSIONS = Object.freeze({ v1: '1.0.0', v2: '1.1.0', destructive: '2.0.0' });

/** The parts taken from `examples/service-desk`, each at the same path in the package. */
export const SERVICE_DESK_PARTS = Object.freeze([
  { path: 'resources/ticket.ts', kind: 'resource' },
  { path: 'recipes/sla-rule.ts', kind: 'recipe' },
  { path: 'app/api/tickets/route.ts', kind: 'page' },
  { path: 'app/api/tickets/[id]/route.ts', kind: 'page' },
  { path: 'app/tickets/page.tsx', kind: 'page' },
  { path: 'app/tickets/new/page.tsx', kind: 'page' },
  { path: 'app/tickets/[id]/page.tsx', kind: 'page' },
  { path: 'app/tickets/[id]/edit/page.tsx', kind: 'page' },
  { path: 'tests/ticket.test.ts', kind: 'test' },
]);

/** The fixture's own test of {@link SLA_RECIPE}. */
export const SLA_RECIPE_TEST_PATH = 'tests/sla-rule.test.ts';

/** The service desk's ticket migration, and where the fixture packs it (ADR-0166 D2). */
export const SERVICE_DESK_MIGRATION = 'db/migrations/0003_create_tickets.sql';
export const MIGRATION = 'migrations/0000_create_tickets.sql';
/** The migration only the destructive version appends. */
export const DESTRUCTIVE_MIGRATION = 'migrations/0001_drop_ticket_priority.sql';
/** The one file version 1.1.0 changes, and how. */
export const CHANGED_IN_V2 = 'recipes/sla-rule.ts';
const V2_CHANGE = Object.freeze({ from: 'p2: 4 * HOUR_MS', to: 'p2: 8 * HOUR_MS' });

/** The schema the service desk's migration names, replaced by the installer's (ADR-0166 D6). */
const SERVICE_DESK_SCHEMA = '"app_service_desk"';

/** The tests the scenario needs to have passed: the blueprint's two and the minimal app's ref. */
export const SCENARIO_TESTS = Object.freeze([
  'a member creates a ticket and lists it',
  'the SLA rule lists the open tickets past their SLA and leaves the others',
  'the helper reads notes as the person and is refused an update outside agents.write',
]);

/** Prepended to the service desk's `recipes/sla-rule.ts`: what {@link SLA_RECIPE} imports. */
export const SLA_RECIPE_IMPORTS = `import { defineRecipe, schedule, type ScheduleInput } from '@indx-workspace/app';

import ticket from '../resources/ticket.ts';

`;

/**
 * Appended to the service desk's `recipes/sla-rule.ts`, so the blueprint's `recipe` part is a
 * recipe: the rule applied every five minutes, read as the member `SLA_ON_CALL_MEMBER` names. It
 * only reads: a recipe writes app data as the person's agent, so every write needs an agent run
 * (ADR-0164), and the fixture brings no agent; the service desk's `sla-sweep` is the one that
 * escalates.
 */
export const SLA_RECIPE = `
/**
 * The SLA rule as a recipe: every five minutes, the open tickets past their SLA and the priority
 * each would be raised to, as the step's output on the run's graph. It reads as the member
 * SLA_ON_CALL_MEMBER names (ADR-0164) and, without one, refuses to run rather than read as anybody.
 */
export default defineRecipe({
  name: 'sla-rule',
  on: schedule('*/5 * * * *', 'UTC'),
  async run({ input, step, store }) {
    const now = new Date((input as ScheduleInput).slot);
    const actingFor = process.env['SLA_ON_CALL_MEMBER'];
    if (actingFor === undefined || actingFor === '') {
      throw new Error('SLA_ON_CALL_MEMBER is not set: name the member the SLA rule reads as');
    }
    await step(
      'breached',
      async () => {
        const pages = await Promise.all(
          OPEN_STATUSES.map((status) => store(ticket).list({ where: { status }, limit: 200 })),
        );
        return pages
          .flatMap((page) => page.items)
          .filter((row) => isBreached(row, now))
          .map((row) => ({ id: row.id, raisedTo: raised(row.priority) }));
      },
      { actingFor },
    );
  },
});
`;

/** The fixture's test of {@link SLA_RECIPE}, at {@link SLA_RECIPE_TEST_PATH}. */
export const SLA_RECIPE_TEST = `import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { fakePerson, recipeHarness } from '@indx-workspace/app/testing';

import recipe from '../recipes/sla-rule.ts';
import ticket from '../resources/ticket.ts';

const HOUR_MS = 60 * 60 * 1000;

afterEach(() => {
  delete process.env['SLA_ON_CALL_MEMBER'];
});

void test('${SCENARIO_TESTS[1]}', async () => {
  const harness = recipeHarness(recipe, { agents: {} });
  process.env['SLA_ON_CALL_MEMBER'] = harness.personId;
  const requester = fakePerson({ principalId: harness.personId });
  const opened = (priority: 'p1' | 'p4') =>
    harness.storeOf(ticket).create(requester, {
      title: 'VPN down',
      description: [{ type: 'paragraph', text: 'Nobody can connect.' }],
      status: 'new',
      priority,
      requester: harness.personId,
      assignee: harness.personId,
    });
  const late = await opened('p1');
  await opened('p4');
  harness.advance(5 * HOUR_MS);
  const slot = new Date(Date.parse('2026-01-01T00:00:00.000Z') + 5 * HOUR_MS).toISOString();

  const run = await harness.start({ slot }, { person: null, dedupeKey: \`schedule:sla-rule:\${slot}\` });

  assert.equal(run.status, 'completed');
  const step = harness.state().steps.find((each) => each.key === 'breached');
  assert.deepEqual(step?.output, [{ id: late.id, raisedTo: 'p1' }]);
  assert.equal(harness.storeOf(ticket).auditEvents().length, 2);
});
`;

/**
 * `text` with `from` replaced by `to`, refused when `text` does not hold `from`: the fixture is
 * assembled from the service desk's files, and a change there must fail here rather than pass
 * with an assembly that no longer does what it says.
 *
 * @param {string} text @param {string} from @param {string} to @param {string} file
 */
function replacedIn(text, from, to, file) {
  if (!text.includes(from)) throw new Error(`${file} no longer holds ${from}`);
  return text.replaceAll(from, to);
}

/** The app kit's version in this checkout: the fixture's `appKit` is `^` it. */
export function appKitVersion() {
  return String(JSON.parse(readFileSync(APP_KIT_MANIFEST, 'utf8')).version);
}

/**
 * Every file of one version of the fixture blueprint, by its path in the package: `package.json`
 * (no scripts, an exact version), `blueprint.json` and the parts. Reads only through `read`.
 *
 * @param {keyof typeof FIXTURE_VERSIONS} variant
 * @param {{ appKit: string, read?: (file: string) => string }} options
 * @returns {Map<string, string>}
 */
export function fixtureFiles(variant, { appKit, read = readServiceDesk }) {
  const version = FIXTURE_VERSIONS[variant];
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const part of SERVICE_DESK_PARTS) files.set(part.path, read(part.path));
  let rule = `${SLA_RECIPE_IMPORTS}${files.get(CHANGED_IN_V2) ?? ''}${SLA_RECIPE}`;
  if (variant !== 'v1') rule = replacedIn(rule, V2_CHANGE.from, V2_CHANGE.to, CHANGED_IN_V2);
  files.set(CHANGED_IN_V2, rule);
  files.set(SLA_RECIPE_TEST_PATH, SLA_RECIPE_TEST);
  const migration = replacedIn(
    read(SERVICE_DESK_MIGRATION),
    SERVICE_DESK_SCHEMA,
    '"{{appSchema}}"',
    SERVICE_DESK_MIGRATION,
  );
  files.set(MIGRATION, migration);
  const migrations = [MIGRATION];
  if (variant === 'destructive') {
    files.set(
      DESTRUCTIVE_MIGRATION,
      'ALTER TABLE "{{appSchema}}"."tickets" DROP COLUMN "priority";\n',
    );
    migrations.push(DESTRUCTIVE_MIGRATION);
  }
  const parts = [...SERVICE_DESK_PARTS, { path: SLA_RECIPE_TEST_PATH, kind: 'test' }].map(
    (part) => ({ path: part.path, kind: part.kind }),
  );
  const manifest = {
    name: BLUEPRINT_NAME,
    version,
    appKit: `^${appKit}`,
    parts,
    slots: { connectors: [], secrets: [], agents: [] },
    migrations,
  };
  const packageJson = {
    name: BLUEPRINT_PACKAGE,
    version,
    description: "The service desk's ticket and SLA rule, as an app blueprint (a test fixture)",
    keywords: [BLUEPRINT_KEYWORD],
    license: 'Apache-2.0',
  };
  files.set('package.json', `${JSON.stringify(packageJson, null, 2)}\n`);
  files.set('blueprint.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return files;
}

/** @param {string} file */
function readServiceDesk(file) {
  return readFileSync(path.join(SERVICE_DESK, file), 'utf8');
}

/**
 * Run `command` and return its status and output, never throwing.
 *
 * @param {string} command @param {readonly string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} options
 */
function attempt(command, args, options) {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: 900_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error === undefined ? '' : String(result.error)}`,
  };
}

/**
 * Writes one version's files into `directory` and packs them with `npm pack --ignore-scripts`
 * into `packs`; returns the tarball's path.
 *
 * @param {keyof typeof FIXTURE_VERSIONS} variant @param {string} directory @param {string} packs
 * @param {{ env: NodeJS.ProcessEnv, appKit: string }} options
 */
export function packFixture(variant, directory, packs, { env, appKit }) {
  rmSync(directory, { recursive: true, force: true });
  for (const [file, contents] of fixtureFiles(variant, { appKit })) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), contents);
  }
  mkdirSync(packs, { recursive: true });
  const packed = attempt(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', packs],
    { cwd: directory, env },
  );
  if (packed.status !== 0) throw new Error(`npm pack of the fixture failed:\n${packed.output}`);
  const [result] = JSON.parse(packed.stdout);
  return path.join(packs, String(result.filename));
}

/**
 * The scenario's test outcome: the command passed and each of {@link SCENARIO_TESTS} ran and
 * passed; a missing, skipped or todo one fails it.
 *
 * @param {{ status: number, output: string }} command
 * @param {readonly { title: string, status: string }[]} results
 * @returns {string | undefined} the problem, or `undefined` when there is none
 */
export function scenarioTestProblem(command, results) {
  if (command.status !== 0) return `the tests exited ${String(command.status)}:\n${command.output}`;
  for (const title of SCENARIO_TESTS) {
    const named = results.filter((result) => result.title === title);
    if (named.length === 0) return `no test is titled '${title}'`;
    const unsettled = named.find((result) => result.status !== 'passed');
    if (unsettled !== undefined) return `the test '${title}' is ${unsettled.status}, not passed`;
  }
  return undefined;
}

/** The last lines of `text`, for a reason. @param {string} text */
const tail = (text) => text.trim().split('\n').slice(-12).join('\n');

/** @param {string} file */
const sha256 = (file) =>
  existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'absent';

/** The files an update may touch, hashed, to prove a refused or planned one changed none. */
const WATCHED = [
  'aw-generated.json',
  'app.config.ts',
  'db/migrations/meta/_journal.json',
  CHANGED_IN_V2,
  'resources/ticket.ts',
];

/** @param {string} copy */
const watched = (copy) => WATCHED.map((file) => `${file}:${sha256(path.join(copy, file))}`).join();

/** The installed `blueprint:<name>` entry of the copy's `aw-generated.json`. @param {string} copy */
function installedEntry(copy) {
  const manifest = JSON.parse(readFileSync(path.join(copy, 'aw-generated.json'), 'utf8'));
  return manifest.entries[`blueprint:${BLUEPRINT_NAME}`];
}

/** A scenario check that failed: its reason ends the scenario. */
class ScenarioFailure extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(reason);
    this.name = 'ScenarioFailure';
  }
}

/** @param {boolean} holds @param {string} reason */
function check(holds, reason) {
  if (!holds) throw new ScenarioFailure(reason);
}

/**
 * `npx --no-install aw <args>` in the copy, which must exit `expected`.
 *
 * @param {string} copy @param {NodeJS.ProcessEnv} env @param {readonly string[]} args
 * @param {number} expected
 */
function aw(copy, env, args, expected) {
  const label = `aw ${args.map((arg) => (path.isAbsolute(arg) ? path.basename(arg) : arg)).join(' ')}`;
  console.log(`   $ ${label}`);
  const result = attempt('npx', ['--no-install', 'aw', ...args], { cwd: copy, env });
  check(
    result.status === expected,
    `${label} exited ${String(result.status)}, not ${String(expected)}:\n${tail(result.output)}`,
  );
  return result.output;
}

/**
 * `aw blueprint update` against a loopback registry that serves only `tarball`.
 *
 * @param {{ copy: string, env: NodeJS.ProcessEnv, work: string }} at
 * @param {string} tarball @param {string} version @param {readonly string[]} flags
 * @param {number} expected
 */
async function updateFrom(at, tarball, version, flags, expected) {
  const directory = path.join(at.work, `registry-${version}`);
  mkdirSync(directory, { recursive: true });
  const served = await spawnPackageServer({ [BLUEPRINT_PACKAGE]: tarball }, directory);
  try {
    const env = { ...at.env, npm_config_registry: served.url };
    const args = ['blueprint', 'update', BLUEPRINT_NAME, '--to', version, ...flags];
    return aw(at.copy, env, args, expected);
  } finally {
    served.close();
  }
}

/** The app the fixture is installed into, whose schema is `app_<name>`. */
const INSTALLING_APP = 'minimal';

/**
 * The installed migrations applied (ADR-0166 Proof: "its migrations apply"): the app kit's own
 * `aw-app migrate`, as `aw dev` runs it, against a throwaway PostgreSQL from the pinned
 * `embedded-postgres` (the native path of `pnpm test`, no Docker), then the blueprint's table
 * looked up in the app's schema.
 *
 * @param {string} copy @param {NodeJS.ProcessEnv} env
 */
async function migrationsApply(copy, env) {
  const cleanup = createCleanup();
  try {
    const { url } = await startNativePostgres(cleanup);
    const args = ['migrate', '--app', INSTALLING_APP, '--dir', 'db/migrations'];
    console.log(`   $ aw-app ${args.join(' ')}`);
    const migrated = attempt('npx', ['--no-install', 'aw-app', ...args], {
      cwd: copy,
      env: { ...env, DATABASE_URL: url },
    });
    check(
      migrated.status === 0,
      `aw-app migrate exited ${String(migrated.status)}:\n${tail(migrated.output)}`,
    );
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const table = `app_${INSTALLING_APP}.tickets`;
      const found = await client.query('SELECT to_regclass($1) AS name', [table]);
      check(found.rows[0]?.name !== null, `the installed migration did not create ${table}`);
    } finally {
      await client.end();
    }
  } finally {
    const failures = await cleanup.run();
    check(
      failures.length === 0,
      `stopping PostgreSQL failed: ${failures.map((failure) => failure.label).join(', ')}`,
    );
  }
}

/**
 * The scenario after the copy is installed: add, build, test, update (planned, applied, refused)
 * and destroy. Throws a {@link ScenarioFailure} at the first check that does not hold.
 */
async function scenarioSteps({ copy, work, env, packs, nodeTests }) {
  const before = watched(copy);
  aw(copy, env, ['blueprint', 'add', packs.v1], 3);
  check(watched(copy) === before, 'aw blueprint add without --yes changed a file');
  aw(copy, env, ['blueprint', 'add', packs.v1, '--yes'], 0);
  const entry = installedEntry(copy);
  check(
    entry?.source?.version === FIXTURE_VERSIONS.v1,
    `aw-generated.json records no blueprint:${BLUEPRINT_NAME} at ${FIXTURE_VERSIONS.v1}`,
  );
  for (const file of [
    'resources/ticket.ts',
    CHANGED_IN_V2,
    'db/migrations/0004_create_tickets.sql',
  ]) {
    check(entry.files[file] !== undefined, `blueprint:${BLUEPRINT_NAME} does not record ${file}`);
  }
  const migration = readFileSync(path.join(copy, 'db/migrations/0004_create_tickets.sql'), 'utf8');
  check(migration.includes('"app_minimal"."tickets"'), 'the migration does not name app_minimal');
  await migrationsApply(copy, env);
  console.log('   $ next build');
  const built = attempt('npx', ['--no-install', 'next', 'build'], { cwd: copy, env });
  check(built.status === 0, `next build exited ${String(built.status)}:\n${tail(built.output)}`);
  const tested = nodeTests(copy);
  const problem = scenarioTestProblem(
    { status: tested.status, output: tail(tested.output) },
    tested.results ?? [],
  );
  check(problem === undefined, problem ?? '');
  const installed = watched(copy);
  const proposal = await updateFrom({ copy, env, work }, packs.v2, FIXTURE_VERSIONS.v2, [], 3);
  check(
    proposal.includes(`update    ${CHANGED_IN_V2}`),
    `the proposal does not update ${CHANGED_IN_V2}:\n${tail(proposal)}`,
  );
  check(watched(copy) === installed, 'aw blueprint update without --yes changed a file');
  const refusal = await updateFrom(
    { copy, env, work },
    packs.destructive,
    FIXTURE_VERSIONS.destructive,
    ['--yes'],
    1,
  );
  check(
    refusal.includes(DESTRUCTIVE_MIGRATION),
    `the destructive version is not refused by name:\n${tail(refusal)}`,
  );
  check(watched(copy) === installed, 'a refused aw blueprint update changed a file');
  await updateFrom({ copy, env, work }, packs.v2, FIXTURE_VERSIONS.v2, ['--yes'], 0);
  check(
    readFileSync(path.join(copy, CHANGED_IN_V2), 'utf8').includes(V2_CHANGE.to),
    `${CHANGED_IN_V2} is not 1.1.0's`,
  );
  check(
    installedEntry(copy)?.source?.version === FIXTURE_VERSIONS.v2,
    `aw-generated.json does not record ${FIXTURE_VERSIONS.v2}`,
  );
  aw(copy, env, ['destroy', 'blueprint', BLUEPRINT_NAME, '--yes'], 0);
  check(
    installedEntry(copy) === undefined && !existsSync(path.join(copy, 'resources/ticket.ts')),
    'aw destroy blueprint left the blueprint installed',
  );
  return `installed ${BLUEPRINT_PACKAGE}@${FIXTURE_VERSIONS.v1} into minimal: migrations applied, built, ${String(tested.results?.length ?? 0)} tests passed; 1.1.0 proposed (exit 3) then applied, 2.0.0 refused by ${path.basename(DESTRUCTIVE_MIGRATION)}, removed by aw destroy blueprint`;
}

/**
 * The scenario: the fixture packed, a fresh copy of `examples/minimal` installed (`install`, as
 * the lane's install step does it), then {@link scenarioSteps}. `ok` or `failed`, with the reason.
 *
 * @param {{
 *   work: string,
 *   env: NodeJS.ProcessEnv,
 *   install: (copy: string) => { status: string, reason: string },
 *   nodeTests: (copy: string) => { status: number, output: string, results?: { title: string, status: string }[] },
 * }} options
 * @returns {Promise<{ status: 'ok' | 'failed', reason: string }>}
 */
export async function runBlueprintScenario({ work, env, install, nodeTests }) {
  const root = path.join(work, 'blueprint');
  const copy = path.join(root, 'minimal-with-blueprint');
  try {
    const appKit = appKitVersion();
    /** @type {Record<keyof typeof FIXTURE_VERSIONS, string>} */
    const packs = { v1: '', v2: '', destructive: '' };
    for (const variant of /** @type {const} */ (['v1', 'v2', 'destructive'])) {
      packs[variant] = packFixture(
        variant,
        path.join(root, 'fixture', variant),
        path.join(root, 'packs'),
        { env, appKit },
      );
    }
    const installed = install(copy);
    if (installed.status !== 'ok')
      return { status: 'failed', reason: `install: ${installed.reason}` };
    return {
      status: 'ok',
      reason: await scenarioSteps({ copy, work: root, env, packs, nodeTests }),
    };
  } catch (error) {
    return {
      status: 'failed',
      reason: error instanceof ScenarioFailure ? error.message : `threw: ${tail(String(error))}`,
    };
  }
}
