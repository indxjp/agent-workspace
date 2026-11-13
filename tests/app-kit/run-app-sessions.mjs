/* global console, URL, fetch */
import { reserveDevRuntime } from './run-process.mjs';
import { readBootstrapAdmin } from './run-projects.mjs';
import { signIn, signInConfigured, startAndVerifyOwnerRun } from './run-identity.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SCRIPTED_MODEL, withModel } from './run-projects.mjs';
import { startDev, readyWithAnyApp } from './run-process.mjs';

async function verifyPortalPasswordFlow({ page, personCookie, email, password, appOrigin }) {
  console.log('== portal: / asks to sign in, and its link leads to /sign-in');
  await page.goto('/');
  await page.getByRole('heading', { name: 'Sign in required' }).waitFor();
  await page.getByRole('main').getByRole('link', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.pathname === '/sign-in');
  await page.getByRole('heading', { name: 'Sign in to portal' }).waitFor();
  await page.getByRole('main').getByRole('link', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.pathname === '/authorize');

  console.log('== portal: a wrong password is refused at the issuer and stays signed out');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Local console password').fill(`not-${String(password)}`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('alert').getByText('That email or password was not accepted.').waitFor();
  if (new URL(page.url()).pathname !== '/authorize' || (await personCookie()) !== undefined)
    throw new Error(`a wrong password signed the portal in: ${page.url()}`);

  console.log("== portal: the Owner's password signs the portal in");
  await page.getByLabel('Local console password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.origin === appOrigin && url.pathname === '/');
  await page.getByRole('heading', { name: 'portal', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Sign out' }).waitFor();
  const signedIn = await personCookie();
  if (signedIn === undefined || !signedIn.value.startsWith('awo_live_') || !signedIn.httpOnly)
    throw new Error("the portal's cookie holds no HttpOnly awo_live_ token");

  return signedIn;
}

async function verifyPortalRunAndSignOut({ page, personCookie, owner, origin, signedIn }) {
  const runId = await startAndVerifyOwnerRun(owner.page, {
    origin,
    accessToken: signedIn.value,
    personToken: owner.token,
    agentName: 'assistant',
  });

  // ADR-0161's run-list amendment (#1530): the Dashboard and /runs read the run list with the
  // person's awo_live_ token, so the run just started is listed, never a "not available" line.
  console.log('== portal: the Dashboard and /runs list the run as the signed-in person');
  await page.goto('/');
  await page
    .getByRole('region', { name: 'Recent runs' })
    .getByRole('link', { name: `Run ${runId}` })
    .waitFor();
  await page.goto('/runs');
  await page.getByRole('heading', { name: 'Runs', level: 1 }).waitFor();
  await page.getByRole('link', { name: `Run ${runId}` }).waitFor();

  console.log('== portal: signing out clears the cookie');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL((url) => url.pathname === '/sign-in');
  if ((await personCookie()) !== undefined) throw new Error('sign-out left the cookie');
  console.log('== portal: signed in under aw dev, and the run was the Owner’s');
}

/**
 * The portal signs a person in under `aw dev` (issues #1510 and #2075): `/` shows the sign-in
 * notice, its link leads to `/sign-in` and on to the development issuer's form. A wrong password
 * is refused there and the portal stays signed out; the Owner's password lands on `/` signed in,
 * with the `awo_live_` token in the app's `HttpOnly` cookie. A run started with that token is the
 * Owner's, and signing out clears the cookie.
 *
 * @param {string} project @param {NodeJS.ProcessEnv} env @param {string} scripts
 */
export async function portalSignsIn(project, env, scripts) {
  const agentFile = path.join(project, 'agents/assistant.ts');
  writeFileSync(
    agentFile,
    withModel(readFileSync(agentFile, 'utf8'), `scripted:${SCRIPTED_MODEL}`),
  );
  const aw = path.join(project, 'node_modules/@indx-workspace/aw/dist/index.js');
  const { origin, devEnv, devArgs } = await reserveDevRuntime({
    env,
    scripts,
    bases: { web: 3700, gateway: 14700, runner: 18700, database: 26700 },
  });
  const dev = startDev(aw, project, devEnv, devArgs);
  /** @type {import('@playwright/test').Browser | undefined} */
  let browser;
  try {
    console.log('== portal: aw dev');
    await dev.waitFor(readyWithAnyApp);
    const appOrigin = /^ {2}app {7}(http:\/\/127\.0\.0\.1:\d+)$/mu.exec(dev.output.stdout)?.[1];
    const { email, password } = readBootstrapAdmin(project);
    if (appOrigin === undefined || email === undefined)
      throw new Error('aw dev named no app, or agent-workspace.yaml no bootstrapAdmin');
    await signInConfigured(appOrigin);

    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch();
    const owner = await signIn(browser, origin, {
      email,
      password,
    });
    const portal = await browser.newContext({ baseURL: appOrigin, locale: 'en-US' });
    const page = await portal.newPage();
    page.setDefaultTimeout(120_000);
    const personCookie = async () =>
      (await portal.cookies(appOrigin)).find((cookie) => cookie.name === 'aw_user_token');

    const signedIn = await verifyPortalPasswordFlow({
      page,
      personCookie,
      email,
      password,
      appOrigin,
    });
    await verifyPortalRunAndSignOut({ page, personCookie, owner, origin, signedIn });
  } catch (error) {
    console.error(`aw dev stdout:\n${dev.output.stdout}\naw dev stderr:\n${dev.output.stderr}`);
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    await dev.stop();
  }
}

/**
 * The wiki's migration applied: `aw dev` in the wiki project until it is ready, and the signed-in
 * person's `GET /api/pages` answers 200 with no pages.
 *
 * @param {string} project @param {NodeJS.ProcessEnv} env @param {string} scripts
 */
export async function wikiServes(project, env, scripts) {
  const aw = path.join(project, 'node_modules/@indx-workspace/aw/dist/index.js');
  const { origin, devEnv, devArgs } = await reserveDevRuntime({
    env,
    scripts,
    bases: { web: 3500, gateway: 14500, runner: 18500, database: 26500 },
  });
  const dev = startDev(aw, project, devEnv, devArgs);
  /** @type {import('@playwright/test').Browser | undefined} */
  let browser;
  try {
    console.log('== wiki: aw dev');
    await dev.waitFor(readyWithAnyApp);
    const appOrigin = /^ {2}app {7}(http:\/\/127\.0\.0\.1:\d+)$/mu.exec(dev.output.stdout)?.[1];
    const { email, password } = readBootstrapAdmin(project);
    if (appOrigin === undefined || email === undefined)
      throw new Error('aw dev named no app, or agent-workspace.yaml no bootstrapAdmin');
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch();
    const { token } = await signIn(browser, origin, {
      email,
      password,
    });
    const listed = await fetch(`${appOrigin}/api/pages`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await listed.json();
    if (listed.status !== 200 || !Array.isArray(body.items) || body.items.length !== 0) {
      throw new Error(
        `GET /api/pages answered ${String(listed.status)}: ${JSON.stringify(body)}, not 200 with no pages`,
      );
    }
    console.log('== wiki: GET /api/pages answers 200 with no pages');
  } catch (error) {
    console.error(`aw dev stdout:\n${dev.output.stdout}\naw dev stderr:\n${dev.output.stderr}`);
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    await dev.stop();
  }
}
