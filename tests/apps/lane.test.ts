/**
 * The apps-e2e lane's pure half (`lane.mjs`, issue #1531): its step ids, the per-app plan, and
 * how step outcomes map to the benchmark's verdicts. The lane itself runs in CI (`apps-e2e`).
 */
import { renderComposeApps } from '@indx-workspace/cli/deploy';
import { parseProjectFile } from '@indx-workspace/sdk/project';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

import { APP_CELLS } from './benchmark.ts';
import {
  agentOnDataOutcome,
  appSchema,
  attemptAsync,
  blockedReason,
  cellVerdicts,
  claimedVerdict,
  composeAppsProblem,
  helmAppsProblem,
  JOURNEY_LOCALES,
  journeyEnv,
  journeyResults,
  journeysOutcome,
  LANE_CELLS,
  LANE_SCENARIOS,
  LANE_STEPS,
  laneFindings,
  parseLaneArgs,
  renderLaneSummary,
  renderScenarioSummary,
  standInImage,
  STEP_CELLS,
  STEP_NEEDS,
  TEST_RESULTS_REPORTER,
  testResults,
  withProductionApps,
  withTarballDependencies,
  withThemeLocale,
  type StepOutcome,
} from './lane.mjs';
import { EXAMPLES_DIR } from './registry.ts';

const ok = (reason = 'passed'): StepOutcome => ({ status: 'ok', reason });

const allOk = (): Map<string, StepOutcome> => new Map(LANE_STEPS.map((step) => [step, ok()]));

const BENCHMARK = {
  id: 'minimal',
  cells: {
    journeys: { verdict: 'gap', ref: 'J3: a member opens a note and edits it' },
    agentOnData: { verdict: 'ok', ref: 'the helper reads notes' },
    selfHost: { verdict: 'ok', ref: 'self-host' },
  },
} as const;

describe('the lane steps', () => {
  it('are the lane refs, in order, each measuring a benchmark cell', () => {
    expect(LANE_STEPS).toStrictEqual([
      'regenerate',
      'install',
      'build',
      'test',
      'depcruise',
      'journeys',
      'self-host',
    ]);
    for (const step of LANE_STEPS) {
      expect(APP_CELLS, step).toContain(STEP_CELLS[step]);
      for (const need of STEP_NEEDS[step]) {
        expect(LANE_STEPS.indexOf(need), `${step} needs ${need}`).toBeLessThan(
          LANE_STEPS.indexOf(step),
        );
      }
    }
    expect(new Set(Object.values(STEP_CELLS))).toStrictEqual(new Set(LANE_CELLS));
    const laneCells: readonly string[] = LANE_CELLS;
    expect(APP_CELLS.filter((cell) => !laneCells.includes(cell))).toStrictEqual(['handwritten']);
  });

  it('plans every registered app unless --app names some, and --skip names steps', () => {
    expect(parseLaneArgs([], ['minimal', 'wiki'])).toStrictEqual({
      apps: ['minimal', 'wiki'],
      skip: new Set(),
    });
    expect(
      parseLaneArgs(['--app', 'wiki', '--skip', 'self-host,regenerate'], ['minimal', 'wiki']),
    ).toStrictEqual({ apps: ['wiki'], skip: new Set(['self-host', 'regenerate']) });
    expect(() => parseLaneArgs(['--app', 'crm'], ['minimal'])).toThrow('not a registered app');
    expect(() => parseLaneArgs(['--skip', 'deploy'], ['minimal'])).toThrow('not a lane step');
    expect(parseLaneArgs(['--skip', 'blueprint,journeys'], ['minimal'])).toStrictEqual({
      apps: ['minimal'],
      skip: new Set(['blueprint', 'journeys']),
    });
    expect(LANE_SCENARIOS).toStrictEqual(['blueprint']);
    expect(LANE_STEPS).not.toContain('blueprint');
    expect(() => parseLaneArgs(['--app'], ['minimal'])).toThrow('usage:');
  });

  it('blocks a step that is skipped or whose prerequisite did not pass, never one that may run', () => {
    const outcomes = new Map<string, StepOutcome>([
      ['install', { status: 'failed', reason: 'npm install exited 1' }],
    ]);
    expect(blockedReason('build', outcomes, new Set())).toBe('needs install, which did not pass');
    expect(blockedReason('regenerate', outcomes, new Set())).toBeUndefined();
    expect(blockedReason('regenerate', outcomes, new Set(['regenerate']))).toBe(
      'skipped by --skip',
    );
    expect(blockedReason('build', new Map([['install', ok()]]), new Set())).toBeUndefined();
  });
});

describe('the lane verdicts', () => {
  it('maps every cell to ok only when each of its steps passed', () => {
    const verdicts = cellVerdicts(allOk());
    for (const cell of LANE_CELLS)
      expect(verdicts[cell]).toStrictEqual({ verdict: 'ok', reasons: [] });
  });

  it('maps a failed step, a gap and a step that never ran to a gap for its cell, with the reason', () => {
    const outcomes = allOk();
    outcomes.set('build', { status: 'failed', reason: 'next build exited 1' });
    outcomes.set('self-host', { status: 'gap', reason: 'Docker is not available' });
    outcomes.delete('regenerate');

    const verdicts = cellVerdicts(outcomes);

    expect(verdicts.agentOnData).toStrictEqual({
      verdict: 'gap',
      reasons: ['build: next build exited 1'],
    });
    expect(verdicts.selfHost.reasons).toStrictEqual(['self-host: Docker is not available']);
    expect(verdicts.generated).toStrictEqual({
      verdict: 'gap',
      reasons: ['regenerate: did not run'],
    });
    expect(verdicts.noFork.verdict).toBe('ok');
  });

  it('fails a claimed ok measured as a gap, and only notes a declared gap measured ok', () => {
    const outcomes = allOk();
    outcomes.set('self-host', { status: 'gap', reason: 'Docker is not available' });

    const findings = laneFindings(BENCHMARK, cellVerdicts(outcomes));

    expect(findings.failures).toStrictEqual([
      'minimal.selfHost is claimed ok but measured a gap: self-host: Docker is not available',
    ]);
    expect(findings.notices).toStrictEqual([
      'minimal.journeys is declared a gap but passed; declare it ok',
    ]);
    expect(claimedVerdict(BENCHMARK, 'generated')).toBe('ok');
    expect(claimedVerdict(BENCHMARK, 'journeys')).toBe('gap');
  });

  it('fails each journeys problem a declared gap does not excuse', () => {
    expect(
      laneFindings(BENCHMARK, cellVerdicts(allOk()), ["the journey 'a member creates' failed"])
        .failures,
    ).toStrictEqual(["minimal: the journey 'a member creates' failed"]);
  });
});

describe('the journeys step', () => {
  it('runs Playwright without blocking, so a run reaches the scripted model the lane serves', async () => {
    const server = createServer((_request, response) => response.end('served'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const ran = await attemptAsync(
        process.execPath,
        [
          '-e',
          `fetch('http://127.0.0.1:${String(port)}').then(async (r) => console.log(await r.text()))`,
        ],
        { timeoutMs: 30_000 },
      );

      expect(ran).toMatchObject({ status: 0, stdout: 'served\n' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // Issue #2076: a journeys pass that blocked this process left a run's model request unanswered
  // until Playwright returned; the lane then stopped `aw dev`, and the answer it finally got sent
  // the run's tool call to the stopped app (ECONNREFUSED). Nothing the journeys await may block.
  it('makes no synchronous call while the journeys run', async () => {
    const source = await readFile(path.join(import.meta.dirname, 'lane.mjs'), 'utf8');
    const body = (name: string) => {
      const start = source.indexOf(`async function ${name}(`);
      const end = source.indexOf('\n}\n', start);
      expect(start, `lane.mjs defines ${name}`).toBeGreaterThan(-1);
      return source.slice(start, end);
    };
    for (const name of ['journeysStep', 'playwrightRun']) {
      expect(body(name), name).not.toMatch(/\b(?:attempt|spawnSync|execSync|execFileSync)\(/u);
    }
    expect(body('playwrightRun')).toMatch(/\battemptAsync\(/u);
  });

  // Issue #2075: each journey signs its browser in through the app's /sign-in at aw dev's
  // development issuer as the bootstrap Owner, so the lane hands Playwright that sign-in.
  it("hands Playwright the Owner's sign-in and the person token, and prints neither", async () => {
    const owner = { email: 'owner@example.test', password: `local-${String(process.pid)}` };
    const run = {
      appUrl: 'http://127.0.0.1:3600',
      origin: 'http://127.0.0.1:3500',
      token: 'awu_live_e2e',
      copy: '/work/minimal',
      locale: 'ja',
      report: '/work/reports/minimal-ja.json',
      owner,
    };

    expect(journeyEnv({ PATH: '/bin' }, run)).toStrictEqual({
      PATH: '/bin',
      APPS_E2E_APP_URL: run.appUrl,
      APPS_E2E_PLATFORM_URL: run.origin,
      APPS_E2E_PERSON_TOKEN: run.token,
      APPS_E2E_OWNER_EMAIL: owner.email,
      APPS_E2E_OWNER_PASSWORD: owner.password,
      APPS_E2E_APP_DIR: run.copy,
      APPS_E2E_LOCALE: run.locale,
      APPS_E2E_REPORT: run.report,
    });
    const source = await readFile(path.join(import.meta.dirname, 'lane.mjs'), 'utf8');
    const logged = source.match(/console\.(?:log|error)\([^;]*;/gu) ?? [];
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expect(line).not.toMatch(/owner|password|token\b/iu);
  });

  const report = {
    suites: [
      {
        title: 'minimal/e2e/minimal.e2e.mjs',
        specs: [{ title: 'a member creates a note and opens it', ok: true }],
        suites: [{ specs: [{ title: 'J3: a member opens a note and edits it', ok: false }] }],
      },
    ],
  };

  it('reads every spec of a Playwright JSON report, nested suites included', () => {
    expect(journeyResults(report)).toStrictEqual([
      { title: 'a member creates a note and opens it', ok: true },
      { title: 'J3: a member opens a note and edits it', ok: false },
    ]);
    expect(journeyResults({})).toStrictEqual([]);
  });

  it('lets a declared gap excuse exactly the journey it names', () => {
    const results = journeyResults(report);
    expect(journeysOutcome(BENCHMARK, results)).toStrictEqual({
      status: 'failed',
      reason: 'failed: J3: a member opens a note and edits it',
      unexcused: [],
    });
    const claimed = {
      ...BENCHMARK,
      cells: {
        ...BENCHMARK.cells,
        journeys: { ...BENCHMARK.cells.journeys, verdict: 'ok' as const },
      },
    };
    expect(journeysOutcome(claimed, results).unexcused).toStrictEqual([
      "the journey 'J3: a member opens a note and edits it' failed",
    ]);
    const other = [
      { title: 'a member creates a note and opens it', ok: false },
      { title: BENCHMARK.cells.journeys.ref, ok: true },
    ];
    expect(journeysOutcome(BENCHMARK, other).unexcused).toStrictEqual([
      "the journey 'a member creates a note and opens it' failed",
    ]);
  });

  it('lets a declared gap excuse the further journeys it names in alsoExcused, and no others', () => {
    const named = {
      ...BENCHMARK,
      cells: {
        ...BENCHMARK.cells,
        journeys: {
          ...BENCHMARK.cells.journeys,
          alsoExcused: ['a member creates a note and opens it'],
        },
      },
    };
    const bothFail = [
      { title: 'a member creates a note and opens it', ok: false },
      { title: BENCHMARK.cells.journeys.ref, ok: false },
    ];
    expect(journeysOutcome(named, bothFail)).toStrictEqual({
      status: 'failed',
      reason:
        'failed: a member creates a note and opens it, J3: a member opens a note and edits it',
      unexcused: [],
    });
    expect(
      journeysOutcome(named, [...bothFail, { title: 'another', ok: false }]).unexcused,
    ).toStrictEqual(["the journey 'another' failed"]);
    expect(
      journeysOutcome(named, [{ title: BENCHMARK.cells.journeys.ref, ok: false }]).unexcused,
    ).toStrictEqual(["no journey is titled 'a member creates a note and opens it'"]);
    const claimed = {
      ...named,
      cells: { ...named.cells, journeys: { ...named.cells.journeys, verdict: 'ok' as const } },
    };
    expect(journeysOutcome(claimed, bothFail).unexcused).toStrictEqual([
      "the journey 'a member creates a note and opens it' failed",
      "the journey 'J3: a member opens a note and edits it' failed",
    ]);
  });

  it('is never ok, and fails the lane even for a declared gap, when no journey ran or none has the ref title', () => {
    expect(journeysOutcome(BENCHMARK, [])).toStrictEqual({
      status: 'failed',
      reason: 'no journey ran',
      unexcused: ['no journey ran'],
    });
    expect(journeysOutcome(BENCHMARK, [{ title: 'another', ok: true }])).toStrictEqual({
      status: 'failed',
      reason: "no journey is titled 'J3: a member opens a note and edits it'",
      unexcused: ["no journey is titled 'J3: a member opens a note and edits it'"],
    });
    expect(
      journeysOutcome(BENCHMARK, [{ title: BENCHMARK.cells.journeys.ref, ok: true }]),
    ).toStrictEqual({ status: 'ok', reason: '1 journeys passed', unexcused: [] });
  });
});

describe('the test step', () => {
  const REF = BENCHMARK.cells.agentOnData.ref;
  const passed = { status: 0, reason: 'node --test exited 0' };

  it('is ok only when the test titled as the agentOnData ref ran and passed', () => {
    expect(
      agentOnDataOutcome(BENCHMARK, passed, [
        { title: 'another', status: 'passed' },
        { title: REF, status: 'passed' },
      ]),
    ).toStrictEqual({ status: 'ok', reason: `2 tests settled; '${REF}' passed` });
  });

  it('is a gap when the ref test is skipped, todo or missing, though the command exited 0', () => {
    for (const status of ['skipped', 'todo'] as const) {
      expect(agentOnDataOutcome(BENCHMARK, passed, [{ title: REF, status }])).toStrictEqual({
        status: 'gap',
        reason: `the test '${REF}' is ${status}, not passed`,
      });
    }
    expect(
      agentOnDataOutcome(BENCHMARK, passed, [{ title: 'another', status: 'passed' }]),
    ).toStrictEqual({ status: 'gap', reason: `no test is titled '${REF}'` });
    expect(
      agentOnDataOutcome(BENCHMARK, passed, [
        { title: REF, status: 'passed' },
        { title: REF, status: 'skipped' },
      ]).status,
    ).toBe('gap');
  });

  it('fails when the command failed, whatever the results', () => {
    expect(
      agentOnDataOutcome(BENCHMARK, { status: 1, reason: 'node --test exited 1' }, [
        { title: REF, status: 'passed' },
      ]),
    ).toStrictEqual({ status: 'failed', reason: 'node --test exited 1' });
  });

  it('refuses a results line that is not a test result', () => {
    expect(() => testResults('{"title":"a","status":"ok"}\n')).toThrow('not a test result');
  });

  it('reports a skipped ref test as skipped from a real node --test run that exits 0', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lane-test-step-'));
    try {
      await writeFile(
        path.join(dir, 'ref.test.mjs'),
        [
          "import { test } from 'node:test';",
          `test(${JSON.stringify(REF)}, { skip: true }, () => {});`,
          "test('a todo', { todo: true }, () => {});",
          "test('another', () => {});",
          '',
        ].join('\n'),
      );
      const results = path.join(dir, 'results.jsonl');
      const run = await attemptAsync(
        process.execPath,
        [
          '--test',
          `--test-reporter=${TEST_RESULTS_REPORTER}`,
          `--test-reporter-destination=${results}`,
          'ref.test.mjs',
        ],
        { cwd: dir },
      );
      expect(run.status, run.output).toBe(0);
      const settled = testResults(await readFile(results, 'utf8'));
      expect(
        settled.filter((result) => result.title !== path.join(dir, 'ref.test.mjs')),
      ).toStrictEqual([
        { title: REF, status: 'skipped' },
        { title: 'a todo', status: 'todo' },
        { title: 'another', status: 'passed' },
      ]);
      expect(agentOnDataOutcome(BENCHMARK, { status: 0, reason: '' }, settled)).toStrictEqual({
        status: 'gap',
        reason: `the test '${REF}' is skipped, not passed`,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the self-host step', () => {
  const image = standInImage('minimal');

  it("adds a production environment the project file's own parser accepts", async () => {
    const text = await readFile(path.join(EXAMPLES_DIR, 'minimal', 'agent-workspace.yaml'), 'utf8');

    const deployed = parseProjectFile(withProductionApps(text, { minimal: image }, 'kubernetes'));

    expect(deployed.project.environments.production).toStrictEqual({
      target: 'kubernetes',
      url: 'https://platform.apps-lane.test',
      apps: { minimal: { image, url: 'https://minimal.apps-lane.test' } },
    });
    expect(() => withProductionApps(`${text}name2: x\n`, {}, 'single-vm')).toThrow(
      'does not end with its environments block',
    );
  });

  it('checks the overlay runs the image on the app role, and the Helm values name the schema', () => {
    const rendered = renderComposeApps(
      { minimal: { image, url: 'https://minimal.apps-lane.test' } },
      'https://platform.apps-lane.test',
    );
    expect(rendered).toContain(`image: ${image}`);
    expect(rendered).toContain('postgres://app_minimal:');
    const compose = {
      services: {
        'app-minimal-role': {},
        'app-minimal': {
          image,
          environment: { DATABASE_URL: 'postgres://app_minimal:x@postgres/db' },
        },
      },
    };
    expect(composeAppsProblem(compose, 'minimal', image)).toBeUndefined();
    expect(
      composeAppsProblem(
        {
          services: {
            ...compose.services,
            'app-minimal': {
              image,
              environment: { DATABASE_URL: 'postgres://agent_workspace:x@postgres/db' },
            },
          },
        },
        'minimal',
        image,
      ),
    ).toBe("app-minimal's DATABASE_URL is not for the role app_minimal");
    expect(composeAppsProblem({ services: {} }, 'minimal', image)).toBe(
      'compose.apps.yaml has no app-minimal service',
    );

    const values = {
      apps: [{ name: 'minimal', image, host: 'minimal.apps-lane.test', schema: 'app_minimal' }],
    };
    expect(helmAppsProblem(values, 'minimal', image)).toBeUndefined();
    expect(helmAppsProblem({ apps: [] }, 'minimal', image)).toBe(
      'the Helm values list no app minimal',
    );
    expect(appSchema('service-desk')).toBe('app_service_desk');
  });

  it('gives an app whose image did not build a digest reference that names no real image', () => {
    expect(image).toMatch(/^registry\.apps-lane\.test\/minimal@sha256:[0-9a-f]{64}$/u);
    expect(standInImage('wiki')).not.toBe(image);
  });
});

describe('the install step', () => {
  it('points the published packages at the tarballs and keeps the template overrides', () => {
    const manifest = {
      dependencies: { '@indx-workspace/app': '0.6.12', next: '16.4.3' },
      devDependencies: { '@indx-workspace/cli': '0.6.12' },
      overrides: { 'undici@>=7.0.0 <7.30.1': '^7.30.1' },
    };
    const tarballs = { '@indx-workspace/app': '/p/app.tgz', '@indx-workspace/cli': '/p/cli.tgz' };

    expect(withTarballDependencies(manifest, tarballs)).toStrictEqual({
      dependencies: { '@indx-workspace/app': 'file:/p/app.tgz', next: '16.4.3' },
      devDependencies: { '@indx-workspace/cli': 'file:/p/cli.tgz' },
      overrides: {
        'undici@>=7.0.0 <7.30.1': '^7.30.1',
        '@indx-workspace/app': 'file:/p/app.tgz',
        '@indx-workspace/cli': 'file:/p/cli.tgz',
      },
    });
  });
});

describe('the summary', () => {
  it('shows one row per app and every reason', () => {
    const outcomes = allOk();
    outcomes.set('self-host', {
      status: 'failed',
      reason: 'npm run image exited 1:\nMissing script: "build"',
    });

    const summary = renderLaneSummary([
      { benchmark: { id: 'minimal' }, verdicts: cellVerdicts(outcomes) },
    ]);

    expect(summary).toContain('| minimal | ✅ | ✅ | ✅ | ❌ | ✅ |');
    expect(summary).toContain('- minimal.selfHost: self-host: npm run image exited 1:');
  });

  it("gives a scenario one line: its mark and its reason's first line", () => {
    expect(renderScenarioSummary('blueprint', { status: 'ok', reason: 'installed\nmore' })).toBe(
      '✅ scenario blueprint: installed\n',
    );
    expect(renderScenarioSummary('blueprint', { status: 'failed', reason: 'exited 1' })).toBe(
      '❌ scenario blueprint: exited 1\n',
    );
    expect(renderScenarioSummary('blueprint', { status: 'gap', reason: 'skipped by --skip' })).toBe(
      '⏭️ scenario blueprint: skipped by --skip\n',
    );
  });
});

describe('the journeys locales', () => {
  it("runs every app's journeys in en and in ja, setting app/theme.ts's locale for each", async () => {
    const theme = await readFile(path.join(EXAMPLES_DIR, 'minimal', 'app', 'theme.ts'), 'utf8');

    expect(JOURNEY_LOCALES).toEqual(['en', 'ja']);
    expect(withThemeLocale(theme, 'ja')).toBe(theme.replace("locale: 'en',", "locale: 'ja',"));
    expect(withThemeLocale(withThemeLocale(theme, 'ja') ?? '', 'en')).toBe(theme);
  });

  it('refuses a theme that names no locale rather than running the journeys in the wrong one', () => {
    expect(withThemeLocale('export const theme = { radius: 8 };\n', 'ja')).toBeUndefined();
  });
});

describe('the journeys run', () => {
  // The scripted model answers from the lane's own process: a Playwright run that blocked it
  // left the helper's model request unanswered, so its run never settled (#1527).
  it('keeps the lane serving while the command runs', async () => {
    const server = createServer((_request, response) => response.end('answered'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const ran = await attemptAsync(process.execPath, [
        '-e',
        `fetch('http://127.0.0.1:${String(port)}/').then((r) => r.text()).then((t) => process.stdout.write(t))`,
      ]);

      expect(ran).toMatchObject({ status: 0, stdout: 'answered' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('answers the status and output of a command that fails, and -1 for one that cannot start', async () => {
    const failed = await attemptAsync(process.execPath, [
      '-e',
      "console.error('refused'); process.exit(3)",
    ]);
    const missing = await attemptAsync('apps-lane-no-such-command', []);

    expect(failed).toMatchObject({ status: 3, stdout: '' });
    expect(failed.output).toContain('refused');
    expect(missing.status).toBe(-1);
  });
});
