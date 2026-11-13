import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The `node --test` reporter the test step writes each test's result with. */
export const TEST_RESULTS_REPORTER = path.join(ROOT, 'tests/apps/test-results-reporter.mjs');

/** The lane's steps, in the order they run; each id is a lane ref. */
export const LANE_STEPS = [
  'regenerate',
  'install',
  'build',
  'test',
  'depcruise',
  'journeys',
  'self-host',
];

/** The benchmark cell each step measures. */
export const STEP_CELLS = {
  regenerate: 'generated',
  install: 'agentOnData',
  build: 'agentOnData',
  test: 'agentOnData',
  depcruise: 'noFork',
  journeys: 'journeys',
  'self-host': 'selfHost',
};

/** The steps each step needs to have passed. */
export const STEP_NEEDS = {
  regenerate: [],
  install: [],
  build: ['install'],
  test: ['install'],
  depcruise: ['install'],
  journeys: ['install'],
  'self-host': ['install'],
};

/**
 * The scenarios that run once, after every app, and measure no benchmark cell; `--skip` takes
 * their ids as it takes a step's. `'blueprint'` runs only when `minimal` is among the apps.
 */
export const LANE_SCENARIOS = ['blueprint'];

/** The cells the lane measures, in the scoreboard's order. */
export const LANE_CELLS = ['generated', 'journeys', 'agentOnData', 'selfHost', 'noFork'];

/** The cells an app declares in `benchmark.ts`; the lane takes the others as claimed `ok`. */
export const DECLARED_CELLS = ['journeys', 'agentOnData', 'selfHost'];

/** The platform's URL in the lane's deploy plans: never resolved, never served. */
export const PLATFORM_URL = 'https://platform.apps-lane.test';

/** @param {string} name */
export const appUrl = (name) => `https://${name}.apps-lane.test`;

/** `app_<name>`, the schema and role an app's data lives in (`appSchemaName` of the contracts). */
export const appSchema = (name) => `app_${name.replaceAll('-', '_')}`;

// ---------------------------------------------------------------------------------------------
// The impure half: everything below runs commands.

/** The line of `aw dev`'s ready screen that names the app's origin. */
export const READY_APP = /^ {2}app {7}(http:\/\/127\.0\.0\.1:\d+)$/mu;

export const APP_TESTS = 'node --test tests/**/*.test.ts';

/** The languages every app's journeys run in: `app/theme.ts` is set to each in turn. */
export const JOURNEY_LOCALES = ['en', 'ja'];
