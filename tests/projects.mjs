/**
 * The Nx / Vitest projects the root `tests/` tree is split into — the one list every consumer
 * reads: the Vitest configs (`tests/vitest.config.ts` and `tests/<dir>/vitest.config.ts`), and
 * `scripts/policy-check-test-inputs.mjs`, which proves each project's Nx `test` inputs cover what
 * its files read.
 *
 * Why split at all: the root `tests/` project used to be one Nx project at the repository root
 * with `implicitDependencies: ["*"]`, so every change — a typo in a doc included — ran all ~260
 * files, one at a time (ADR-0053 Amendment 2026-11-19f). Each project here has its own
 * `project.json` whose `test` target names the paths it reads as inputs, so `nx affected` runs it
 * only when one of them changed, and the cache replays it otherwise.
 *
 * Each entry:
 * - `name` — the Nx project and the Vitest project (`vitest run --project <name>`);
 * - `projectRoot` — the directory holding its `project.json` (and its `vitest.config.ts`);
 * - `root` — the Vitest root, which `include` / `exclude` are relative to;
 * - `include` / `exclude` — the files it collects;
 * - `pool` / `isolate` / `fileParallelism` — how Vitest runs them. Every project keeps Vitest's
 *   `forks` pool with isolation: `vitest doctor` measured `pool: 'threads'` slower or failing on
 *   every project it ran (+20 % to +53 %, a timeout in tests-tooling), and `isolate: false` gained
 *   10 % on none once re-measured back to back (ADR-0053 Amendment 2026-11-19f has the
 *   numbers). Only tests-next runs its files one at a time;
 * - `groupOrder` — Vitest's `sequence.groupOrder`: in one `vitest run` over every project
 *   (`pnpm test`), a higher group starts only after every lower one has finished.
 *
 * All paths are relative to the repository root, POSIX-style.
 *
 * @typedef {{
 *   readonly name: string;
 *   readonly projectRoot: string;
 *   readonly root: string;
 *   readonly include: readonly string[];
 *   readonly exclude: readonly string[];
 *   readonly pool: 'forks' | 'threads';
 *   readonly isolate: boolean;
 *   readonly fileParallelism: boolean;
 *   readonly groupOrder: number;
 * }} TestsProject
 */

import process from 'node:process';

/** Vitest's own default `include`, restated so the guard collects exactly what Vitest does. */
const DEFAULT_INCLUDE = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];

/**
 * Suites that read far less of the repository than the project their directory belongs to, and
 * are slow enough that running them on every change that project sees costs real time. Each is a
 * project of its own whose `test` target declares only what it reads, so `nx affected` runs it
 * when one of those paths changed and replays it otherwise (ADR-0053 Amendment 2026-11-19f):
 *
 * - `tests-eject-typecheck` type-checks each ejected project with `tsc` against the pinned engine
 *   SDKs: it reads the platform, contract, SDK and engine adapter packages;
 * - `tests-sdk-reference` renders the SDK reference pages from contracts, sdk and aw.
 *
 * Paths are relative to the `tests/` Vitest root.
 *
 * @type {readonly { name: string; directory: string; include: readonly string[] }[]}
 */
const NARROW_SUITES = [
  {
    name: 'tests-eject-typecheck',
    directory: 'eject-typecheck',
    include: ['platforms/eject-typecheck.test.ts'],
  },
  {
    name: 'tests-sdk-reference',
    directory: 'sdk-reference',
    include: ['docs/generate-sdk-reference.test.ts'],
  },
];

/**
 * The storage load test (the storage design, §07 "Load test"): a 1 GiB body round-trips through
 * every object-store backend with flat memory. It is collected only when `AW_LOAD_TESTS=1`, which
 * ci.yml's "Storage load test" step sets — on every diff that reaches the storage code or
 * tests/load, and on every run with no diff base (the nightly run, a manual dispatch). Without
 * the variable it used to run anyway at 256 MiB, a weaker copy of that step on every change the
 * `tests` project sees.
 */
export const LOAD_TEST_SUITES = ['load/object-store-round-trip.test.ts'];

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean} whether the storage load test is collected
 */
export function loadTestsEnabled(env) {
  return env['AW_LOAD_TESTS'] === '1';
}

/**
 * The two suites that start `next dev` against apps/web. Next 16 refuses a second dev server for
 * one directory, and both plant route fixtures in apps/web/app while they run, so they run one at
 * a time, in their own project, which Nx runs with no other task beside it (`parallelism: false`
 * in tests/next/project.json).
 */
const NEXT_SERVER_SUITES = ['auth.test.ts', 'no-route-answers-503.test.ts'];

/**
 * A project that collects every test file below one directory of tests/.
 *
 * @param {string} directory
 * @returns {TestsProject}
 */
function subdirectory(directory) {
  return {
    name: `tests-${directory}`,
    projectRoot: `tests/${directory}`,
    root: `tests/${directory}`,
    include: DEFAULT_INCLUDE,
    // A narrow suite that lives in this directory belongs to its own project.
    exclude: NARROW_SUITES.flatMap(({ include }) => include)
      .filter((file) => file.startsWith(`${directory}/`))
      .map((file) => file.slice(directory.length + 1)),
    pool: 'forks',
    isolate: true,
    fileParallelism: true,
    groupOrder: 0,
  };
}

const SUBDIRECTORIES = ['docs', 'tooling', 'store', 'gallery', 'conformance', 'formal'];

/**
 * A project that collects the named files of one narrow suite (`NARROW_SUITES`). Its root holds
 * only its `project.json` and `vitest.config.ts`; the files stay where they are.
 *
 * @param {{ name: string; directory: string; include: readonly string[] }} suite
 * @returns {TestsProject}
 */
function narrow({ name, directory, include }) {
  return {
    name,
    projectRoot: `tests/${directory}`,
    root: 'tests',
    include,
    exclude: [],
    pool: 'forks',
    isolate: true,
    fileParallelism: true,
    groupOrder: 0,
  };
}

/**
 * Every `tests/` project, the remainder (`tests`) last. The remainder collects what no other
 * project does, so a file added anywhere under tests/ is collected by exactly one project.
 *
 * @param {{ readonly loadTests?: boolean }} [options] `loadTests` — collect the storage load test
 *   (`LOAD_TEST_SUITES`); by default, when `AW_LOAD_TESTS=1`.
 * @returns {readonly TestsProject[]}
 */
export function testsProjects({ loadTests = loadTestsEnabled(process.env) } = {}) {
  /** @type {TestsProject} */
  const next = {
    name: 'tests-next',
    projectRoot: 'tests/next',
    root: 'tests',
    include: NEXT_SERVER_SUITES,
    exclude: [],
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    // In `pnpm test`, which runs every Vitest project in one process, this project runs after all
    // the others have finished: its route fixtures in apps/web/app would otherwise be seen by
    // the inventories that walk that tree while it runs.
    groupOrder: 1,
  };
  /** @type {TestsProject} */
  const remainder = {
    name: 'tests',
    projectRoot: 'tests',
    root: 'tests',
    include: DEFAULT_INCLUDE,
    exclude: [
      // Playwright specs use a different runner and are never Vitest suites.
      'browser/**',
      ...SUBDIRECTORIES.map((directory) => `${directory}/**`),
      ...NEXT_SERVER_SUITES,
      ...NARROW_SUITES.flatMap(({ include }) => include),
      ...(loadTests ? [] : LOAD_TEST_SUITES),
    ],
    pool: 'forks',
    isolate: true,
    fileParallelism: true,
    groupOrder: 0,
  };
  return [...SUBDIRECTORIES.map(subdirectory), ...NARROW_SUITES.map(narrow), next, remainder];
}

/**
 * One project by name.
 *
 * @param {string} name
 * @returns {TestsProject}
 */
export function testsProject(name) {
  const found = testsProjects().find((project) => project.name === name);
  if (found === undefined) throw new Error(`tests/projects.mjs declares no project "${name}"`);
  return found;
}
