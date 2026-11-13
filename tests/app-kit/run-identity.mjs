/* global fetch, console, setTimeout */

import { readFileSync } from 'node:fs';
import path from 'node:path';
export { pkcePair, devIssuerCode, signInAtDevIssuer } from './run-oidc.mjs';
export { startAndWaitForAgentRun, startAndVerifyOwnerRun } from './run-owner-runs.mjs';

export { SIGN_IN_PROOF_ROUTE, signInProofRoute } from './run-sign-in-proof.mjs';

/**
 * Sign in as the bootstrap Owner through the console's form and approve a device code: the page
 * and the person token (`awu_live_…`) `aw login` would hold. The apps lane signs in so too.
 *
 * @param {import('@playwright/test').Browser} browser
 * @param {string} origin @param {{ email: string, password: string }} admin
 */
export async function signIn(browser, origin, admin) {
  const page = await (await browser.newContext({ baseURL: origin })).newPage();
  await page.goto('/signin');
  await page.getByLabel('Email').fill(admin.email);
  await page.getByLabel('Password').fill(admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/signin'));
  const device = await (await fetch(`${origin}/api/auth/cli-device`, { method: 'POST' })).json();
  await page.goto(`/api/auth/cli-verify?code=${encodeURIComponent(device.userCode)}`);
  await page.locator('input[name="confirm"]').check();
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.waitForLoadState();
  // The verify page's policy allows no fetch; the console's own pages do.
  await page.goto('/');
  const issued = await fetch(`${origin}/api/auth/cli-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceCode: device.deviceCode }),
  });
  if (issued.status !== 200) throw new Error(`cli-token answered ${String(issued.status)}`);
  const { token } = await issued.json();
  return { page, token };
}

/**
 * Store the app's identity secret `APP_<NAME>_IDENTITY` from the signed-in Owner's console, as the
 * docs say: secrets are an Owner's (spec §21) and `aw dev` holds an Admin key, so it only says
 * which secret to add and where its value is (`.aw/app-identity.json`). Throws when `aw dev` did
 * not say so in `stderr`, or the console refused it. The apps lane stores it so too.
 *
 * @param {import('@playwright/test').Page} page @param {string} project
 * @param {string} appName @param {string} stderr `aw dev`'s standard error so far
 */
export async function storeAppIdentity(page, project, appName, stderr) {
  const identityName = `APP_${appName.toUpperCase().replaceAll('-', '_')}_IDENTITY`;
  if (!stderr.includes(`add ${identityName} under Secrets`)) {
    throw new Error(`aw dev did not say how to add ${identityName}:\n${stderr}`);
  }
  console.log(`== adding ${identityName} as the Owner`);
  const identity = JSON.parse(readFileSync(path.join(project, '.aw/app-identity.json'), 'utf8'));
  const stored = await page.evaluate(
    async ({ name, value }) =>
      (
        await fetch('/api/secrets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, value }),
        })
      ).status,
    { name: identityName, value: identity.secret },
  );
  if (stored !== 201) throw new Error(`POST /api/secrets answered ${String(stored)}`);
}

/** How long the portal's sign-in may take to be configured: `aw dev` restarts the app with it. */
const SIGN_IN_READY_TIMEOUT_MS = 180_000;

/**
 * Wait until the app's `GET /api/sign-in` redirects to the issuer: `aw dev` restarts the app with
 * its `app-backend` pair after the first sync (ADR-0161 DI10), and until then the sign-in answers
 * `503 sign_in_not_configured` (or nothing, while the app restarts).
 *
 * @param {string} appOrigin
 */
export async function signInConfigured(appOrigin) {
  const deadline = Date.now() + SIGN_IN_READY_TIMEOUT_MS;
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const answered = await fetch(`${appOrigin}/api/sign-in`, {
        redirect: 'manual',
        headers: { accept: 'application/json' },
      });
      if (answered.status === 303) return;
      last = `${String(answered.status)} ${await answered.text()}`;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`the portal's sign-in was not configured in time: ${last}`);
}
