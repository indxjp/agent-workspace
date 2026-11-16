/**
 * The journey's browser steps: each runs one Playwright spec of this directory in the clean
 * machine, against an `aw dev` already up, and says what it proved.
 */
import { JOURNEY_BRAND_COLOUR, JourneyFailure, firstTokenOf, stubExpectation } from './harness.mjs';
import {
  CONFIG_IN,
  DEMO_IN,
  FEEDBACK_SPEC_FILE,
  FILES_SPEC_FILE,
  ORIGINS_SPEC_FILE,
  PINNED_SPEC_FILE,
  PORTAL_IN,
  PORTAL_SPEC_FILE,
  RELEASE_SPEC_FILE,
  RUNNER_CACHE_IN,
  RUNNER_IN,
  SECRETS,
  SPEC_FILE,
  TOOLS_SPEC_FILE,
  VIEWER_SPEC_FILE,
  exec,
  execOk,
  nonce,
  say,
  writeEvidence,
} from './run-support.mjs';

/** J1's features: chat and files, and connectors, which a project with an app needs. */
export const PORTAL_FEATURES = /** @type {const} */ (['chat', 'files', 'connectors']);

/**
 * One Playwright spec in `/runner`; `env` gets the runner's npm cache, which only `npx playwright`
 * is given.
 *
 * @param {string} machine @param {string} specFile
 * @param {{ env: Readonly<Record<string, string>>, timeoutMs: number, grep?: string }} options
 */
function runSpec(machine, specFile, options) {
  const command = ['npx', 'playwright', 'test', '--config', CONFIG_IN, specFile];
  if (options.grep !== undefined) command.push('--grep', options.grep);
  return execOk(machine, command, {
    workdir: RUNNER_IN,
    env: { ...options.env, npm_config_cache: RUNNER_CACHE_IN },
    timeoutMs: options.timeoutMs,
  });
}

/**
 * The browser step in the clean machine; its first-token latency, in seconds. In stub mode the
 * spec also sees the fake's own wording.
 *
 * @param {string} machine
 * @param {{ baseUrl: string, nonce: string, timeoutMs: number, live: boolean }} options
 */
export async function widgetTest(machine, options) {
  const result = await runSpec(machine, SPEC_FILE, {
    env: {
      JOURNEY_BASE_URL: options.baseUrl,
      JOURNEY_NONCE: options.nonce,
      JOURNEY_DEMO_DIR: DEMO_IN,
      JOURNEY_BRAND_COLOUR,
      ...stubExpectation(options.live, `Fake Anthropic reply to ${options.nonce}`),
    },
    timeoutMs: options.timeoutMs,
  });
  return firstTokenOf(result.output);
}

/**
 * One test of `tools.e2e.mjs`, picked by `grep` (`look change` or `tool answer`); its output.
 *
 * @param {string} machine
 * @param {{ baseUrl: string, grep: string, env: Readonly<Record<string, string>>, timeoutMs: number }} options
 */
export async function toolsTest(machine, options) {
  const result = await runSpec(machine, TOOLS_SPEC_FILE, {
    env: { JOURNEY_BASE_URL: options.baseUrl, ...options.env },
    timeoutMs: options.timeoutMs,
    grep: options.grep,
  });
  return result.output;
}

/**
 * The bootstrap admin to sign in as: the email the first `npm run dev` named, and the password read
 * from `.agent-workspace/secrets/local-secrets.json` (the ready screen never prints it, BH061-011),
 * added to {@link SECRETS}.
 *
 * @param {string} machine @param {string | null} email @param {(capMs: number) => number} limit
 * @param {string} [dir] the project whose `aw dev` named the admin
 */
export async function adminOf(machine, email, limit, dir = DEMO_IN) {
  if (email === null) {
    throw new JourneyFailure('the first npm run dev named no bootstrap admin to sign in as');
  }
  const secrets = await exec(machine, ['cat', '.agent-workspace/secrets/local-secrets.json'], {
    workdir: dir,
    quiet: true,
    timeoutMs: limit(30_000),
  });
  /** @type {unknown} */
  const stored = secrets.status === 0 ? JSON.parse(secrets.stdout) : null;
  const password =
    typeof stored === 'object' && stored !== null && 'BOOTSTRAP_ADMIN_PASSWORD' in stored
      ? stored.BOOTSTRAP_ADMIN_PASSWORD
      : undefined;
  if (typeof password !== 'string') {
    throw new JourneyFailure(
      '.agent-workspace/secrets/local-secrets.json holds no bootstrap admin password',
    );
  }
  SECRETS.add(password);
  return { email, password };
}

/**
 * A Viewer key cannot save: `aw check` with it is refused with `403 forbidden`. `viewer.e2e.mjs`
 * mints the key as a person does on the local runtime, signed in to the workspace in the browser
 * as the bootstrap admin, because `aw` holds the local runtime's own key, which may not mint one
 * (S1-21). The ready screen names the admin but never prints the password (BH061-011), so it is
 * read from `.agent-workspace/secrets/local-secrets.json` and reaches the spec through that one
 * `docker exec`'s environment.
 *
 * @param {string} machine @param {string} baseUrl
 * @param {string | null} email
 * @param {(capMs: number) => number} limit
 */
export async function checkViewerForbidden(machine, baseUrl, email, limit) {
  const admin = await adminOf(machine, email, limit);
  await runSpec(machine, VIEWER_SPEC_FILE, {
    env: {
      JOURNEY_BASE_URL: baseUrl,
      JOURNEY_DEMO_DIR: DEMO_IN,
      JOURNEY_ADMIN_EMAIL: admin.email,
      JOURNEY_ADMIN_PASSWORD: admin.password,
    },
    timeoutMs: limit(300_000),
  });
  say('journey: a Viewer key is refused with 403 forbidden');
}

/**
 * Issue #622's demo through `origins.e2e.mjs`: with `allowedOrigins` in `surfaces/main.ts`, the
 * one-tag snippet answers on the listed origin and is refused on another, and a `<Chat baseUrl>`
 * page from `@indx-workspace/react` on the listed origin runs a turn while an unlisted one is
 * refused by CORS. It runs before {@link checkPromoteRollback}, while public surfaces still serve
 * `local`, the pointer its edit moves; it puts `surfaces/main.ts` back as it found it.
 *
 * @param {string} machine @param {string} baseUrl @param {(capMs: number) => number} limit
 */
export async function checkAllowedOrigins(machine, baseUrl, limit) {
  await runSpec(machine, ORIGINS_SPEC_FILE, {
    env: { JOURNEY_BASE_URL: baseUrl, JOURNEY_NONCE: nonce(), JOURNEY_DEMO_DIR: DEMO_IN },
    timeoutMs: limit(300_000),
  });
  say(
    'journey: the widget and a cross-origin <Chat baseUrl> turn answered on an allowed origin and were refused on another',
  );
}

/**
 * Issue #615's demo through `release.e2e.mjs`: `aw promote` and `aw rollback` move `production`
 * and `aw versions` shows both moves. Public surfaces still serve `local`, and the restart check
 * compares version counts, not pointers, so moving `production` here disturbs no later check.
 *
 * @param {string} machine @param {(capMs: number) => number} limit
 */
export async function checkPromoteRollback(machine, limit) {
  await runSpec(machine, RELEASE_SPEC_FILE, {
    env: { JOURNEY_DEMO_DIR: DEMO_IN },
    timeoutMs: limit(300_000),
  });
  say('journey: aw promote and aw rollback move production, aw versions shows both moves');
}

/**
 * Issue #619's demo through `release.e2e.mjs`, against the `aw dev` started with the promotion bar
 * and after `evals/<agent>.yaml` passed: a failing case blocks promotion, and fixing it lets
 * promotion through.
 *
 * @param {string} machine @param {(capMs: number) => number} limit
 */
export async function checkPromotionGate(machine, limit) {
  const output = await runSpec(machine, RELEASE_SPEC_FILE, {
    env: { JOURNEY_DEMO_DIR: DEMO_IN, JOURNEY_PROMOTION_BAR: '1' },
    timeoutMs: limit(600_000),
  });
  const line = /journey: the promotion gate [^\n]*/u.exec(output.output)?.[0];
  say(line ?? 'journey: the promotion gate refused a failing case and passed the fix');
}

/**
 * Issue #620: a thumbs-down in the widget, listed by `aw feedback --negative`, added with
 * `aw eval add-case --yes`, makes `aw eval` fail on that case. `feedback.e2e.mjs` puts
 * `evals/<agent>.yaml` back as it found it.
 *
 * @param {string} machine @param {string} baseUrl @param {(capMs: number) => number} limit
 */
export async function checkFeedbackFails(machine, baseUrl, limit) {
  await runSpec(machine, FEEDBACK_SPEC_FILE, {
    env: { JOURNEY_BASE_URL: baseUrl, JOURNEY_NONCE: nonce(), JOURNEY_DEMO_DIR: DEMO_IN },
    timeoutMs: limit(300_000),
  });
  say('journey: a thumbs-down in the widget and from aw runs rate became eval cases aw eval fails');
}

/**
 * Issue #612: a conversation open on v1 keeps answering as v1 after v2 is pushed, and (issue #618)
 * `aw eval <agent> <v1>` answers as v1 while `local` is on v2. `pinned.e2e.mjs` puts the agent file
 * and `evals/<agent>.yaml` back as it found them.
 *
 * @param {string} machine @param {string} baseUrl @param {(capMs: number) => number} limit
 */
export async function checkPinnedVersion(machine, baseUrl, limit) {
  await runSpec(machine, PINNED_SPEC_FILE, {
    env: { JOURNEY_BASE_URL: baseUrl, JOURNEY_NONCE: nonce(), JOURNEY_DEMO_DIR: DEMO_IN },
    timeoutMs: limit(300_000),
  });
  say(
    'journey: an open conversation stayed on v1 after v2 was pushed, and aw eval v1 answered as v1',
  );
}

/**
 * Issue #1687 (the storage design, §07 browser journey 2) through `files.e2e.mjs`: a file uploaded
 * on the Files screen and granted to the demo agent is read by a run started from the console, and
 * the run's output is listed in Files as `text/markdown` with no staging row. The spec puts the
 * agent file back and waits for that save, so the restart's version comparison sees it.
 *
 * On failure the model turns the spec caused go to `files-model-turns.json` in the evidence: the
 * tools each request offered, the tool use answered, and the start of each request body.
 *
 * @param {string} machine
 * @param {{ baseUrl: string, email: string | null, limit: (capMs: number) => number,
 *   evidence: string, toolRequests: readonly unknown[], bodies: readonly string[] }} options
 */
export async function checkRunFiles(machine, options) {
  const { limit, toolRequests, bodies } = options;
  const admin = await adminOf(machine, options.email, limit);
  const from = { toolRequests: toolRequests.length, bodies: bodies.length };
  try {
    await runSpec(machine, FILES_SPEC_FILE, {
      env: {
        JOURNEY_BASE_URL: options.baseUrl,
        JOURNEY_DEMO_DIR: DEMO_IN,
        JOURNEY_ADMIN_EMAIL: admin.email,
        JOURNEY_ADMIN_PASSWORD: admin.password,
      },
      timeoutMs: limit(300_000),
    });
  } catch (error) {
    const turns = {
      toolRequests: toolRequests.slice(from.toolRequests),
      bodies: bodies.slice(from.bodies).map((body) => body.slice(0, 6_000)),
    };
    writeEvidence(options.evidence, 'files-model-turns.json', JSON.stringify(turns, null, 2));
    throw error;
  }
  say('journey: a run read a granted file, and its output is listed in Files without staging');
}

/**
 * One test of `portal.e2e.mjs` (J1, issue #1510), picked by `grep`, against the portal's `aw dev`:
 * its console and app origins, and the bootstrap admin it named, whose password is read from the
 * portal project's own secrets file.
 *
 * @param {string} machine
 * @param {{ state: { console: string | null, app: string | null, adminEmail: string | null } } | undefined} dev
 * @param {string} grep @param {number} timeoutMs
 */
export async function portalTest(machine, dev, grep, timeoutMs) {
  const consoleOrigin = dev?.state.console ?? null;
  const appOrigin = dev?.state.app ?? null;
  if (dev === undefined || consoleOrigin === null || appOrigin === null) {
    throw new JourneyFailure("the portal's npm run dev named no console or no app");
  }
  const admin = await adminOf(machine, dev.state.adminEmail, () => timeoutMs, PORTAL_IN);
  await runSpec(machine, PORTAL_SPEC_FILE, {
    env: {
      JOURNEY_APP_URL: appOrigin,
      JOURNEY_BASE_URL: consoleOrigin,
      JOURNEY_ADMIN_EMAIL: admin.email,
      JOURNEY_ADMIN_PASSWORD: admin.password,
      JOURNEY_FEATURES: PORTAL_FEATURES.join(','),
    },
    timeoutMs,
  });
}
