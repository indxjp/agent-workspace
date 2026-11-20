/* global fetch, FormData, AbortSignal, URL */
/**
 * Storing a use case's workspace secrets as the docs say: `aw dev` holds an Admin key and only an
 * Owner may store a secret (spec §21, ADR-0109), so a person signs in to the console as the Owner
 * and adds each one under Secrets. The harness does the same over HTTP: it reads the console's URL,
 * the Owner's email and the password file from the ready screen, posts the sign-in form (a plain
 * form a browser without JavaScript can submit, `apps/web/app/signin/page.tsx`), and stores each
 * secret with that session's `POST /api/secrets`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { JourneyFailure } from '../journey/harness.mjs';

const REQUEST_MS = 30_000;

/**
 * @typedef {{ url: string, email: string, passwordFile: string }} ConsoleSignIn what the ready
 *   screen's `console` row says: where the console is, who signs in, and where the password is kept
 */

/**
 * The ready screen's `console` row: its URL, then `sign in as <email>` and `password in <file>`.
 *
 * @param {string} readyScreen `aw dev`'s output up to and including the ready screen
 * @returns {ConsoleSignIn}
 */
export function consoleSignIn(readyScreen) {
  const url = /^\s*console\s+(http:\/\/\S+)\s*$/mu.exec(readyScreen)?.[1];
  const email = /\bsign in as (\S+@\S+)/u.exec(readyScreen)?.[1];
  const passwordFile = /\bpassword in (\S+)/u.exec(readyScreen)?.[1];
  if (url === undefined || email === undefined || passwordFile === undefined) {
    throw new JourneyFailure(`the ready screen names no console sign-in:\n${readyScreen}`);
  }
  return { url, email, passwordFile };
}

/**
 * The hidden fields of the form that holds a `password` input, as a browser would post them.
 *
 * @param {string} html the sign-in page
 * @returns {[string, string][]}
 */
export function signInFormFields(html) {
  const form = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gu)].find((match) =>
    /<input\b[^>]*\bname="password"/u.test(match[1] ?? ''),
  );
  if (form === undefined) throw new JourneyFailure('the sign-in page has no password form');
  return [...(form[1] ?? '').matchAll(/<input\b[^>]*>/gu)].flatMap(([input]) => {
    if (!/\btype="hidden"/u.test(input)) return [];
    const name = /\bname="([^"]*)"/u.exec(input)?.[1];
    const value = /\bvalue="([^"]*)"/u.exec(input)?.[1] ?? '';
    return name === undefined ? [] : [[decodeEntities(name), decodeEntities(value)]];
  });
}

/** @param {string} text */
const decodeEntities = (text) =>
  text
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

/**
 * Sign in to the console as the Owner and answer the session's `Cookie` header.
 *
 * @param {ConsoleSignIn} signIn @param {string} password
 */
async function signInCookie({ url, email }, password) {
  const page = await fetch(new URL('/signin', url), { signal: AbortSignal.timeout(REQUEST_MS) });
  if (page.status !== 200) throw new JourneyFailure(`GET /signin answered ${String(page.status)}`);
  const form = new FormData();
  for (const [name, value] of signInFormFields(await page.text())) form.append(name, value);
  form.append('email', email);
  form.append('password', password);
  const signedIn = await fetch(new URL('/signin', url), {
    method: 'POST',
    body: form,
    headers: { origin: new URL(url).origin },
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0] ?? '')
    .filter((pair) => pair !== '')
    .join('; ');
  if (cookie === '') {
    throw new JourneyFailure(`signing in as ${email} set no cookie (${String(signedIn.status)})`);
  }
  return cookie;
}

/**
 * Store each secret from the console, signed in as the Owner the ready screen names, and answer
 * what was stored (names only, never a value).
 *
 * @param {string} dir the project's copy, where the password file is
 * @param {string} readyScreen @param {Readonly<Record<string, string>>} secrets name → value
 */
export async function storeSecretsAsOwner(dir, readyScreen, secrets) {
  const names = Object.keys(secrets);
  if (names.length === 0) return 'no workspace secrets to add';
  const signIn = consoleSignIn(readyScreen);
  const file = JSON.parse(readFileSync(path.resolve(dir, signIn.passwordFile), 'utf8'));
  const password = file['BOOTSTRAP_ADMIN_PASSWORD'];
  if (typeof password !== 'string' || password === '') {
    throw new JourneyFailure(`${signIn.passwordFile} holds no BOOTSTRAP_ADMIN_PASSWORD`);
  }
  const cookie = await signInCookie(signIn, password);
  const stored = [];
  for (const name of names) {
    const response = await fetch(new URL('/api/secrets', signIn.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: new URL(signIn.url).origin },
      body: JSON.stringify({ name, value: secrets[name] }),
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    if (response.status !== 201) {
      throw new JourneyFailure(
        `adding ${name} as ${signIn.email} answered ${String(response.status)}: ${await response.text()}`,
      );
    }
    stored.push(`added ${name} under Secrets as ${signIn.email}`);
  }
  return stored.join('\n');
}
