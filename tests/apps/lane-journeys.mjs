/* global console */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { freePort, signIn, signInConfigured, startDev, storeAppIdentity } from '../app-kit/run.mjs';
import { readModelScript, startFakeModel } from './fake-model.mjs';
import { ROOT, READY_APP, JOURNEY_LOCALES } from './lane-config.mjs';
import { journeyResults, journeysOutcome } from './lane-results.mjs';
import { attemptAsync, tail } from './lane-commands.mjs';

/**
 * `app/theme.ts` with its `locale` set to `locale`, or `undefined` when it names none. The lane
 * sets it in its own copy of the app, and puts the app's own back after the journeys.
 *
 * @param {string} source @param {string} locale
 */
export function withThemeLocale(source, locale) {
  const named = /^(\s*locale: )'[a-z]{2}'(,?)$/mu;
  return named.test(source) ? source.replace(named, `$1'${locale}'$2`) : undefined;
}

/**
 * The environment of one Playwright run of the app's journeys: the app and the platform, the
 * person token for the app's own API, the running copy, the locale and the report, and the
 * bootstrap Owner's email and local console password, with which each journey signs its browser in
 * through the app's own `/sign-in` and `aw dev`'s development issuer (issue #2075). The lane prints
 * none of them but the app's URL.
 *
 * @param {NodeJS.ProcessEnv} base
 * @param {{ appUrl: string, origin: string, token: string, copy: string, locale: string, report: string, owner: { email: string, password: string } }} run
 */
export function journeyEnv(base, { appUrl, origin, token, copy, locale, report, owner }) {
  return {
    ...base,
    APPS_E2E_APP_URL: appUrl,
    APPS_E2E_PLATFORM_URL: origin,
    APPS_E2E_PERSON_TOKEN: token,
    APPS_E2E_OWNER_EMAIL: owner.email,
    APPS_E2E_OWNER_PASSWORD: owner.password,
    APPS_E2E_APP_DIR: copy,
    APPS_E2E_LOCALE: locale,
    APPS_E2E_REPORT: report,
  };
}

/**
 * One Playwright run of the app's `e2e/` in `locale` (`APPS_E2E_LOCALE`, which each journey
 * checks against `<html lang>`): every journey's result, or the reason there are none.
 *
 * @param {{ id: string, locale: string, appUrl: string, origin: string, token: string, copy: string, work: string, owner: { email: string, password: string } }} options
 */
async function playwrightRun({ id, locale, appUrl, origin, token, copy, work, owner }) {
  const report = path.join(work, 'reports', `${id}-${locale}.json`);
  mkdirSync(path.dirname(report), { recursive: true });
  console.log(`   $ playwright test examples/${id}/e2e (${locale}, the app on ${appUrl})`);
  const ran = await attemptAsync(
    'npx',
    ['--no-install', 'playwright', 'test', '--config', 'playwright.apps.config.mjs', `${id}/e2e/`],
    {
      cwd: ROOT,
      env: journeyEnv(process.env, { appUrl, origin, token, copy, locale, report, owner }),
      timeoutMs: 20 * 60_000,
    },
  );
  console.log(tail(ran.output));
  if (!existsSync(report)) {
    return { problem: `Playwright wrote no report in ${locale}:\n${tail(ran.output)}` };
  }
  return { results: journeyResults(JSON.parse(readFileSync(report, 'utf8'))) };
}

async function runJourneyLocales({ benchmark, id, appUrl, origin, token, copy, work, owner }) {
  const themeFile = path.join(copy, 'app', 'theme.ts');
  const theme = existsSync(themeFile) ? readFileSync(themeFile, 'utf8') : undefined;
  /** @type {{ title: string, ok: boolean }[]} */
  const results = [];
  try {
    for (const locale of JOURNEY_LOCALES) {
      const themed = theme === undefined ? undefined : withThemeLocale(theme, locale);
      if (themed === undefined) {
        const reason = `app/theme.ts names no locale, so the journeys cannot run in ${locale}`;
        return { status: 'failed', reason, unexcused: [reason] };
      }
      writeFileSync(themeFile, themed);
      const ran = await playwrightRun({ id, locale, appUrl, origin, token, copy, work, owner });
      if ('problem' in ran)
        return { status: 'failed', reason: ran.problem, unexcused: [ran.problem] };
      results.push(...ran.results);
    }
  } finally {
    if (theme !== undefined) writeFileSync(themeFile, theme);
  }
  return journeysOutcome(benchmark, results);
}

/**
 * The journeys step: `aw dev`, the Owner's sign-in, the app's identity secret and a person token,
 * then Playwright over the app's `e2e/`.
 *
 * @param {{ id: string, benchmark: import('./benchmark.js').AppBenchmark, copy: string, env: NodeJS.ProcessEnv, work: string, taken: Set<number> }} options
 */
export async function journeysStep({ id, benchmark, copy, env, work, taken }) {
  const fake = await startFakeModel(readModelScript(path.join(copy, 'e2e', 'model-script.json')));
  const ports = {
    web: await freePort(3500, taken),
    gateway: await freePort(14500, taken),
    runner: await freePort(18500, taken),
    database: await freePort(26500, taken),
  };
  const devEnv = {
    ...env,
    ANTHROPIC_API_KEY: fake.key,
    ANTHROPIC_BASE_URL: fake.baseUrl,
    GATEWAY_PORT: String(ports.gateway),
    RUNNER_PORT: String(ports.runner),
    AW_DATABASE_PORT: String(ports.database),
  };
  const origin = `http://127.0.0.1:${String(ports.web)}`;
  const aw = path.join(copy, 'node_modules/@indx-workspace/aw/dist/index.js');
  const dev = startDev(aw, copy, devEnv, ['--port', String(ports.web)]);
  /** @type {import('@playwright/test').Browser | undefined} */
  let browser;
  try {
    await dev.waitFor(({ stdout }) => READY_APP.test(stdout) && /^synced: /mu.test(stdout));
    const appUrl = READY_APP.exec(dev.output.stdout)?.[1] ?? '';
    const secrets = JSON.parse(
      readFileSync(path.join(copy, '.agent-workspace/secrets/local-secrets.json'), 'utf8'),
    );
    const email = /bootstrapAdmin: (\S+)/u.exec(
      readFileSync(path.join(copy, 'agent-workspace.yaml'), 'utf8'),
    )?.[1];
    if (email === undefined) throw new Error('agent-workspace.yaml names no bootstrapAdmin');
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch();
    const owner = { email, password: String(secrets.BOOTSTRAP_ADMIN_PASSWORD) };
    const { page, token } = await signIn(browser, origin, owner);
    await storeAppIdentity(page, copy, id, dev.output.stderr);
    await browser.close();
    browser = undefined;
    // The journeys sign in through the app: wait for `aw dev` to restart it with its sign-in.
    await signInConfigured(appUrl);
    return await runJourneyLocales({ benchmark, id, appUrl, origin, token, copy, work, owner });
  } catch (error) {
    writeFileSync(
      path.join(work, `${id}-aw-dev.log`),
      `${dev.output.stdout}\n${dev.output.stderr}`,
    );
    const reason = `the journeys could not run: ${tail(String(error))}`;
    return { status: 'failed', reason, unexcused: [reason] };
  } finally {
    await browser?.close().catch(() => undefined);
    await dev.stop();
    await fake.close();
  }
}
