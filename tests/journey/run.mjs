#!/usr/bin/env node
/* global console, fetch */
/**
 * The slice-1 exit test (S1-19, issue #457): the four commands a new user runs, on a clean Linux
 * container, against this checkout's own packages, timed against the 600 s budget, with no file
 * edited by hand.
 *
 *   pnpm build && node tests/journey/run.mjs
 *
 * Outside the timer it packs the nine `@indx-workspace` packages (`scripts/release/pack-packages.mjs`)
 * and publishes them to a digest-pinned Verdaccio (`verdaccio.yaml`: the scope is local only, the
 * rest proxies npmjs), so the run does not depend on what npm serves (ADR-0082 D5; the published
 * packages are proven by `install-live`, ADR-0130). It starts the fake Anthropic
 * API (`../generated-project/fake-anthropic.mjs`, unchanged) on the host's loopback, starts the
 * digest-pinned Playwright image as the clean machine (`--network host`, `--user pwuser`, no
 * repository mount and no Docker socket, so `aw dev` runs the `local` driver), and installs
 * `@playwright/test` into `/runner` with an npm cache of its own, so the user's cache stays cold.
 *
 * Timed, each step on its own and the whole on the wall clock: `npm create @indx-workspace@latest
 * demo`, answered on a terminal (`script` gives it one) as a user answers it, the recommended answer
 * to every setup question except the brand colour, `#c0392b` (`JOURNEY_BRAND_COLOUR`), which is
 * not the widget's default, so the launcher's colour proves `surfaces/main.ts` reached the widget;
 * then `npm install`, `npm run dev` until `ready`, `signed in` and the `widget:` line, and
 * `widget.e2e.mjs`. The fake key (`sk-ant-e2e-fake-<random>`) reaches `aw dev` through that one
 * `docker exec`'s environment, never a file or an argument. The record goes to
 * `<work>/journey-timings.json`, to stdout and to `$GITHUB_STEP_SUMMARY`; a run that fails inside
 * the timed part writes the same file with the steps it finished, the step that failed and the
 * wall clock until then (`finished: false`, no budget verdict).
 *
 * Untimed afterwards: `demo/` holds only what `npm create` wrote (tool-owned paths aside); a copy
 * with an `mcp()` tool on engine `pi` is refused with `422 engine_capability_unsupported [mcp]`; a
 * Viewer key is refused with `403 forbidden`; the widget answers on an allowed origin and is
 * refused on another, and so is a cross-origin `<Chat baseUrl>` from `@indx-workspace/react`
 * (`origins.e2e.mjs`, issues #622 and #680); a thumbs-down in the widget becomes an eval case that
 * `aw eval` fails (`feedback.e2e.mjs`, issue #620); a file uploaded in Files and granted to the
 * agent is read by a run started from the console, whose output Files lists without staging
 * (`files.e2e.mjs`, issue #1687, fake model only); and `npm run dev` again, without `ANTHROPIC_*`,
 * keeps the versions and answers through the persisted model connection with the original key.
 *
 * Then the slice-2 exit test (S2-08, issue #550), in the same container. The fake model is
 * `fake-anthropic-tools.mjs` (the slice-1 fake plus one tool turn), and a loopback orders API
 * serves its own OpenAPI document. Each block is timed on its own clock and budget:
 * B2 (60 s) writes a new colour into `surfaces/main.ts` and waits for the launcher to show it;
 * B3b (900 s) hand-writes `tools/orders.ts` and adds it to the agent, restarts `aw dev` with
 * `ORDERS_TOKEN` (`orders-e2e-<random>`, passed like the fake key) and asks the widget; B3a (900 s)
 * runs `npm create` answering `openapi` and `apis/orders.openapi.json`, copies the document there
 * (the developer's input, the one file allowed to appear) and asks the widget, with no file setup
 * wrote edited afterwards. Each must call `GET /orders/<nonce>` with the token, and the reply must
 * carry the order's data. The records go under `budgets` in `journey-timings.json`, B1's staying
 * at the top level. Untimed, under a second `JOURNEY_CHECKS_TIMEOUT_MS` cap: a
 * `policy.permissions.runCommands: false` ceiling makes `aw dev` and `aw check` print the server's
 * `403 policy_cannot_widen [permissions.runCommands]`, and the agent saved before it answers with
 * `Bash` no longer offered to the model; and the token is in no project file but the sealed store,
 * no log, transcript or model request, and not in the runtime's `/proc/<pid>/environ`.
 *
 * Last, J1 (issue #1510), on its own clock against `JOURNEY_PORTAL_BUDGET_SECONDS` (600 s), under
 * `budgets.portal`: `npm create @indx-workspace@latest portal -- --template portal --theme blank
 * --features chat,files,connectors --yes` (`PORTAL_CREATE_ARGS`), `npm install`, `npm run dev`
 * until the ready screen names the console and the app and the first sync is done, and
 * `portal.e2e.mjs` signing the bootstrap admin in through the portal's `/sign-in` and `aw dev`'s
 * development OIDC issuer, until the first signed-in page. Untimed, under `PORTAL_CHECKS_MS`: the
 * console's sidebar shows the chosen features' entries and none of the others.
 *
 * `--live` (issue #609; the nightly `journey-live` workflow) runs the same journey against the real
 * Anthropic API: no fake starts, `aw dev` gets `ANTHROPIC_API_KEY` from this process's environment
 * (the run stops before any Docker work, naming the variable, if it is unset or blank), and only
 * the checks that read the fake's own records (its reply, its tool turn, the tools it was offered)
 * are skipped. Every other check is the same in both modes: the widget shows an answer from a run
 * that finished `completed`, and the orders API saw the tool's request. Each widget answer's
 * first-token latency goes to `firstTokenSeconds` in `journey-timings.json`, beside `model`.
 *
 * It needs Docker and npm on a Linux host. Environment: `JOURNEY_WORK_DIR` (unset or blank: a new
 * temporary directory), `JOURNEY_REGISTRY_PORT` (4873, at most 65535),
 * `JOURNEY_PREPARE_TIMEOUT_MS` (10 minutes: the cap on packing, publishing, pulling and the runner
 * install) and `JOURNEY_CHECKS_TIMEOUT_MS` (10 minutes: the cap on every untimed check after the
 * journey), each a positive integer or the run stops naming it; a cap that runs out is named too.
 * `JOURNEY_REGISTRY` (issue #608; unset or blank: Verdaccio as above) is the post-publish smoke:
 * set to `https://registry.npmjs.org/`, no Verdaccio starts, nothing is packed or published, and
 * the clean machine installs what that registry serves (`docs/release/README.md`).
 * The registry token lives in a temporary directory of its own, removed when the run ends. It never
 * publishes to a public registry and pushes no tag.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import { PUBLISHED_PACKAGES } from '../../scripts/release/pack-packages.mjs';
import { run } from '../generated-project/project.mjs';
import { createOrdersApi } from './fake-anthropic-tools.mjs';
import { JourneyFailure, firstHourSummaryMarkdown, stubExpectation } from './harness.mjs';
import { runJourney } from './run-blocks.mjs';
import {
  copyEvidence,
  prepareRunner,
  removeContainer,
  startMachine,
  startRegistry,
} from './run-machine.mjs';
import {
  CONFIG_IN,
  FIRST_HOUR_SPEC_FILE,
  ROOT,
  RUNNER_CACHE_IN,
  RUNNER_IN,
  SECRETS,
  WORK_IN,
  appendSummary,
  exec,
  execOk,
  remaining,
  say,
  scrub,
  writeEvidence,
} from './run-support.mjs';
import { readRunOptions, startProviders } from './run-start.mjs';
import { writeUnfinishedTimings } from './run-timing.mjs';

export { VERDACCIO_IMAGE, PLAYWRIGHT_IMAGE } from './run-machine.mjs';
export {
  waitForRegistry,
  startRegistry,
  removeContainer,
  pinnedVersion,
  startFakeProvider,
  startMachine,
} from './run-machine.mjs';
export { PORTAL_CHECKS_MS, PORTAL_CREATE_ARGS } from './run-blocks.mjs';
export { startDev, watchDev } from './run-dev.mjs';
export { PORTAL_FEATURES } from './run-specs.mjs';
export { FAKE_KEY_PREFIX, HOME, SECRETS, exec, execOk, say, scrub } from './run-support.mjs';

/** The stopwatch's exec cap: the spec's 10 min test timeout plus a minute (ci.yml's 25 min step). */
const FIRST_HOUR_EXEC_MS = 11 * 60_000;

/**
 * A throwaway Verdaccio user; its token goes into `publish.npmrc` (mode 0600) in `secrets`, a
 * temporary directory of its own that the run removes when it ends, and nowhere else.
 *
 * @param {string} url @param {string} secrets
 */
async function publisherConfig(url, secrets) {
  const password = randomBytes(18).toString('base64url');
  SECRETS.add(password);
  const response = await fetch(`${url}-/user/org.couchdb.user:journey`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'journey', password, type: 'user', roles: [] }),
  });
  /** @type {unknown} */
  const body = await response.json().catch(() => null);
  const token =
    typeof body === 'object' && body !== null && 'token' in body && typeof body.token === 'string'
      ? body.token
      : '';
  if (!response.ok || token === '') {
    throw new JourneyFailure(`Verdaccio refused the publisher (HTTP ${String(response.status)})`);
  }
  SECRETS.add(token);
  const file = path.join(secrets, 'publish.npmrc');
  const host = new URL(url).host;
  writeFileSync(file, `//${host}/:_authToken=${token}\n`, { mode: 0o600 });
  return file;
}

/**
 * Pack the published packages in publish order and publish each to the throwaway registry.
 *
 * @param {string} work @param {string} secrets @param {string} registryUrl
 * @param {number} deadline
 */
export async function publishPackages(work, secrets, registryUrl, deadline) {
  const packs = path.join(work, 'packs');
  const printed = run(
    process.execPath,
    [path.join(ROOT, 'scripts', 'release', 'pack-packages.mjs'), '--out', packs],
    { cwd: ROOT, timeoutMs: Math.min(900_000, remaining(deadline)) },
  );
  const tarballs = printed
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line !== '');
  if (tarballs.length !== PUBLISHED_PACKAGES.length) {
    throw new JourneyFailure(
      `pack-packages printed ${String(tarballs.length)} tarballs, not ${String(PUBLISHED_PACKAGES.length)}`,
    );
  }
  const userconfig = await publisherConfig(registryUrl, secrets);
  for (const tarball of tarballs) {
    say(`== publishing ${path.basename(tarball)} to ${registryUrl}`);
    // `--tag latest` is explicit: npm 11 refuses a prerelease without a tag. The registry is
    // given on the command line, and the user config holds only that registry's token.
    run(
      'npm',
      [
        'publish',
        tarball,
        '--tag',
        'latest',
        '--registry',
        registryUrl,
        '--userconfig',
        userconfig,
      ],
      { cwd: work, timeoutMs: Math.min(300_000, remaining(deadline)) },
    );
  }
}

/**
 * The first-hour stopwatch (issue #700): `first-hour.e2e.mjs` in the clean machine, then its
 * record to `first-hour-timings.json` and the job summary. Its timeout is its own, not B1's.
 *
 * @param {string} machine @param {string} work @param {Readonly<Record<string, string>>} anthropic @param {boolean} live
 */
async function firstHourStopwatch(machine, work, anthropic, live) {
  const out = `${WORK_IN}/first-hour.json`;
  // Only `npx playwright` gets the runner cache; the spec strips it for the user's commands.
  try {
    await execOk(
      machine,
      ['npx', 'playwright', 'test', '--config', CONFIG_IN, FIRST_HOUR_SPEC_FILE],
      {
        workdir: RUNNER_IN,
        env: {
          ...anthropic,
          ...stubExpectation(live, 'Fake Anthropic reply'),
          JOURNEY_FIRST_HOUR_DIR: `${WORK_IN}/fh`,
          JOURNEY_FIRST_HOUR_OUT: out,
          JOURNEY_QUICKSTART: `${RUNNER_IN}/quickstart.mdx`,
          npm_config_cache: RUNNER_CACHE_IN,
        },
        timeoutMs: FIRST_HOUR_EXEC_MS,
      },
    );
  } finally {
    // A failing run keeps the timings it measured; a missing record never hides the failure.
    const record = await exec(machine, ['cat', out], { timeoutMs: 60_000, quiet: true });
    if (record.status === 0) {
      writeFileSync(path.join(work, 'first-hour-timings.json'), record.stdout);
      appendSummary(firstHourSummaryMarkdown(JSON.parse(record.stdout).steps));
    }
  }
  say('journey: first-hour stopwatch written to first-hour-timings.json');
}

/**
 * The registry the clean machine installs from: the published one, or a throwaway Verdaccio with
 * this checkout's packages.
 *
 * @param {RunOptions} options @param {string} registry the Verdaccio container's name
 * @param {string} secrets
 */
async function prepareRegistry(options, registry, secrets) {
  const { published, registryUrl, registryPort, work, deadline } = options;
  if (published !== null) {
    say(`== installing the published packages from ${registryUrl}`);
    return;
  }
  say(`== starting Verdaccio on ${registryUrl}`);
  await startRegistry(registry, registryPort, deadline);
  say('== packing and publishing the nine @indx-workspace packages');
  await publishPackages(work, secrets, registryUrl, deadline);
}

async function main() {
  const options = readRunOptions();
  const { mode, work, evidence, registryUrl, deadline } = options;
  const suffix = randomBytes(4).toString('hex');
  const registry = `journey-registry-${suffix}`;
  const machine = `journey-machine-${suffix}`;
  /** The registry token's directory: never under `work`, removed however the run ends. */
  const secrets = mkdtempSync(path.join(tmpdir(), 'journey-secrets-'));
  /** @type {import('./fake-anthropic-tools.mjs').OrdersCall[]} */
  const calls = [];
  /** @type {import('./run-basics.mjs').JourneyContext} */
  const ctx = {
    machine,
    work,
    evidence,
    live: mode.live,
    checksMs: options.checksMs,
    anthropic: {},
    fakeKey: '',
    requests: [],
    toolRequests: [],
    /** Every model request's raw body, for the secret check. */
    bodies: [],
    calls,
    ordersApi: createOrdersApi(calls),
    ordersOrigin: '',
    devs: [],
  };
  /** @type {LoopbackServers} */
  const servers = {};

  try {
    await prepareRegistry(options, registry, secrets);
    await startProviders(ctx, servers, mode);
    say('== starting the clean machine');
    await startMachine(machine, registryUrl, deadline);
    say('== preparing /runner');
    await prepareRunner(machine, work, deadline);

    if (options.firstHour) {
      await firstHourStopwatch(machine, work, ctx.anthropic, mode.live);
      process.exitCode = 0;
      return;
    }
    await runJourney(ctx);
    process.exitCode = 0;
  } catch (error) {
    if (ctx.timing !== undefined && !ctx.timing.reported) {
      writeUnfinishedTimings(work, ctx.timing, mode.live ? 'live' : 'fake');
    }
    // The evidence artifact carries the failure and the failing command's output, not only the log.
    writeEvidence(
      evidence,
      'failure.log',
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    throw error;
  } finally {
    rmSync(secrets, { recursive: true, force: true });
    for (const [index, dev] of ctx.devs.entries()) {
      dev.kill();
      writeEvidence(evidence, `dev-${String(index + 1)}.log`, dev.state.log);
    }
    copyEvidence(machine, evidence);
    removeContainer(machine);
    removeContainer(registry);
    servers.fake?.close();
    servers.orders?.close();
  }
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
