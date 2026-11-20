/**
 * The shared rig of the email-link route tests: the service, the binder and the directory that
 * ship, over the memory stores, the recording sender and a `fixedClock`, plus the helpers that
 * build the `Request`s the framework would hand the routes and read the answers back.
 */
import type { DemoEntrySlug } from '@indx-workspace/contracts/demo';

import { expect } from 'vitest';

import { signInSessionCookieName } from '../../auth';
import { fixedClock, type FixedClock } from '../../clock';
import { counterIds } from '../../ids';
import type { DirectoryRoot } from '../../rbac/directory';
import { FakeChallengeVerifier } from '../adapters/challenge/fake';
import { createDisposableEmailList } from '../adapters/disposable/disposable';
import { createMemoryGuestWorkspaceBinder } from '../adapters/guest-workspace/memory';
import { MemoryLoginTokenStore } from '../adapters/login-tokens/memory';
import { FakeEmailLinkSender } from '../adapters/sender/fake';
import type { EmailLinkService } from '../ports';
import { createEmailLinkServiceFrom } from '../service';
import { issueEmailLink, verifyEmailLink, type EmailLinkRuntime } from './routes';

export const SECRET = 'an-email-link-route-test-session-secret-long-enough';
export const HOST = 'store.example.test';
export const STORE_ORIGIN = `https://${HOST}`;
const T0 = '2026-11-16T09:00:00.000Z';
export const ISSUE_PATH = '/api/auth/email-link';
export const VERIFY_PATH = '/api/auth/email-link/verify';

/** The one answer the fake challenge verifier passes. */
export const CHALLENGE = 'challenge-answer';

export interface Rig {
  readonly clock: FixedClock;
  readonly sender: FakeEmailLinkSender;
  readonly store: MemoryLoginTokenStore;
  readonly directory: DirectoryRoot;
  readonly runtime: EmailLinkRuntime;
}

type Overrides = {
  readonly sender?: FakeEmailLinkSender | null;
  readonly linkBaseUrl?: string | null;
  readonly challenge?: boolean;
  /** The entries the binder says have a demo template. */
  readonly entries?: readonly string[];
};

export function rig(overrides: Overrides = {}): Rig {
  const clock = fixedClock(T0);
  const ids = counterIds();
  const sender = overrides.sender === null ? null : (overrides.sender ?? new FakeEmailLinkSender());
  const store = new MemoryLoginTokenStore();
  const memory = createMemoryGuestWorkspaceBinder({ ids });
  const { directory } = memory;
  const entries = overrides.entries ?? [];
  const binder = {
    bind: (input: Parameters<typeof memory.binder.bind>[0]) => memory.binder.bind(input),
    hasEntry: (entry: DemoEntrySlug) => Promise.resolve(entries.includes(entry)),
  };
  const service: EmailLinkService = createEmailLinkServiceFrom({
    clock,
    ids,
    clientIdentity: { trustedProxyHops: 1, sessionSecret: SECRET },
    store,
    binder,
    sender,
    linkBaseUrl: overrides.linkBaseUrl === undefined ? STORE_ORIGIN : overrides.linkBaseUrl,
    challenge: overrides.challenge === false ? null : new FakeChallengeVerifier(CHALLENGE),
    disposable: createDisposableEmailList(),
  });
  return {
    clock,
    sender: sender ?? new FakeEmailLinkSender(),
    store,
    directory,
    runtime: { kind: 'ready', service, clock },
  };
}

let nextClient = 0;
/** A client address no other test in this file uses, as a trusted proxy would report it. */
export function client(): string {
  nextClient += 1;
  return `203.0.113.${String(nextClient)}`;
}

type PostOptions = { readonly ip: string; readonly origin?: string | null; readonly raw?: string };

export function post(
  path: string,
  body: unknown,
  options: PostOptions = { ip: client() },
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': options.ip,
  };
  const origin = options.origin === undefined ? STORE_ORIGIN : options.origin;
  if (origin !== null) headers['origin'] = origin;
  return new Request(`https://${HOST}${path}`, {
    method: 'POST',
    headers,
    body: options.raw ?? JSON.stringify(body),
  });
}

/** A sign-up body that passes every check: consent given and the challenge answered. */
export function signUpBody(email: string): {
  readonly email: string;
  readonly consent: true;
  readonly challenge: string;
} {
  return { email, consent: true, challenge: CHALLENGE };
}

export const issue = (
  runtime: EmailLinkRuntime | null,
  email: string,
  ip = client(),
  extra: { readonly challenge?: string; readonly entry?: string } = {},
) => issueEmailLink(post(ISSUE_PATH, { ...signUpBody(email), ...extra }, { ip }), runtime);

export const verify = (
  runtime: EmailLinkRuntime | null,
  body: { email: string; token: string; entry?: string },
  ip = client(),
  secret: string | null = SECRET,
) => verifyEmailLink(post(VERIFY_PATH, body, { ip }), runtime, secret);

/** The `token` the link in the last message carries. */
export function tokenOf(sender: FakeEmailLinkSender): string {
  const message = sender.messages.at(-1);
  if (message === undefined) throw new Error('no link was sent');
  const token = new URLSearchParams(new URL(message.link).hash.slice(1)).get('token');
  if (token === null) throw new Error('the link carries no token');
  return token;
}

export async function problem(response: Response): Promise<{ status: number; code: string }> {
  const body = (await response.json()) as { error: { code: string } };
  return { status: response.status, code: body.error.code };
}

/** The refusals the routes answer, as `problem` reads them. */
export const UNAVAILABLE = { status: 503, code: 'email_link_unavailable' } as const;
export const INVALID_BODY = { status: 400, code: 'invalid_body' } as const;
export const CROSS_ORIGIN = { status: 403, code: 'cross_origin' } as const;
export const LINK_INVALID = { status: 400, code: 'email_link_invalid' } as const;
export const RATE_LIMITED = { status: 429, code: 'email_link_rate_limited' } as const;

/** `name=value` of the session cookie a response sets, or `null`. */
export function sessionCookieOf(response: Response): string | null {
  const cookie = response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${signInSessionCookieName()}=`));
  return cookie === undefined ? null : (cookie.split(';')[0] ?? null);
}

/** Sends a link to `email` and answers the token it carries. */
export async function sentLink(rigged: Rig, email: string): Promise<string> {
  const response = await issue(rigged.runtime, email);
  expect(response.status).toBe(202);
  return tokenOf(rigged.sender);
}
