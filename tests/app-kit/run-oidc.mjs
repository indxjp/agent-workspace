/* global fetch, URLSearchParams, URL, console */
import { createHash, randomBytes } from 'node:crypto';
import { APP_NAME } from './run-projects.mjs';
import { startAndVerifyOwnerRun } from './run-owner-runs.mjs';

/** An S256 PKCE pair (RFC 7636). */
export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/**
 * Sign `email` in at the development issuer through its form, as a browser posts it, and answer
 * the code its redirect carries. Throws on any other answer.
 *
 * @param {{ issuer: string, clientId: string, redirectUri: string, challenge: string }} client
 * @param {{ email: string, password: string }} person
 */
export async function devIssuerCode(client, person) {
  const response = await fetch(`${client.issuer}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: randomBytes(16).toString('base64url'),
      code_challenge: client.challenge,
      code_challenge_method: 'S256',
      email: person.email,
      password: person.password,
    }),
  });
  const location = response.headers.get('location');
  if (response.status !== 302 || location === null)
    throw new Error(`the dev issuer answered ${String(response.status)}, not a redirect`);
  const code = new URL(location).searchParams.get('code');
  if (code === null) throw new Error(`the dev issuer redirected without a code: ${location}`);
  return code;
}

/**
 * Step 6 (issue #2075): the Owner signs in at the development issuer, the app trades the ID token
 * for an `awo_live_` token, and a run started with it is the Owner's. The person token `aw login`
 * holds is still refused on the run route.
 *
 * @param {import('@playwright/test').Page} page the Owner's signed-in console
 * @param {{ origin: string, appOrigin: string, email: string, password: string, personToken: string }} options
 */
export async function signInAtDevIssuer(page, options) {
  console.log('== signing the Owner in at the development issuer');
  const route = `${options.appOrigin}/api/e2e-sign-in`;
  const named = await (await fetch(route)).json();
  if (typeof named.issuer !== 'string' || !named.issuer.startsWith('http://127.0.0.1:'))
    throw new Error(`the app has no development issuer: ${JSON.stringify(named)}`);
  if (named.clientId !== APP_NAME || named.appBackend !== true)
    throw new Error(`the app's sign-in is not configured: ${JSON.stringify(named)}`);
  const { verifier, challenge } = pkcePair();
  const redirectUri = `${options.appOrigin}/api/sign-in/callback`;
  const code = await devIssuerCode(
    { issuer: named.issuer, clientId: named.clientId, redirectUri, challenge },
    { email: options.email, password: options.password },
  );
  const exchanged = await fetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, verifier, redirectUri }),
  });
  const answer = await exchanged.json();
  const { accessToken, expiresIn } = answer;
  if (exchanged.status !== 200 || !String(accessToken).startsWith('awo_live_') || expiresIn !== 300)
    throw new Error(
      `the exchange answered ${String(exchanged.status)}: ${JSON.stringify({ ...answer, accessToken: undefined })}`,
    );

  await startAndVerifyOwnerRun(page, { ...options, accessToken, agentName: 'triage' });
}
