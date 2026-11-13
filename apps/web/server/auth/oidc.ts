import * as oidc from 'openid-client';
import { SignJWT, errors, jwtVerify, type JWTVerifyResult } from 'jose';

import type { OidcConfiguration, OidcIdentity } from '@agent-workspace/core/auth';
import { isLoopbackHost, readDeploymentPosture } from '@agent-workspace/core/posture';

import { systemClock } from '../clock.ts';
import { derivePurposeKey, verificationKeys } from './core/key-ring.ts';

const encoder = new TextEncoder();
/** The unscoped base name; routes use `oidcTransactionCookieName()` from `index.ts` (issue #394). */
export const OIDC_TRANSACTION_COOKIE_BASE_NAME = 'aw_oidc_transaction';
const TRANSACTION_TTL_SECONDS = 600;

export interface OidcTransaction {
  readonly verifier: string;
  readonly state: string;
  readonly expiresAt: number;
}

/**
 * The OIDC configuration with what the environment says about discovering it (ADR-0161 amendment
 * DI9): `allowInsecureDiscovery` is read with the rest, so discovery reads no environment itself.
 * Absent means `false`.
 */
export interface DiscoverableOidcConfiguration extends OidcConfiguration {
  readonly allowInsecureDiscovery?: boolean;
}

export function readOidcConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): DiscoverableOidcConfiguration | null {
  const issuer = env['OIDC_ISSUER_URL']?.trim();
  const clientId = env['OIDC_CLIENT_ID']?.trim();
  const clientSecret = env['OIDC_CLIENT_SECRET']?.trim();
  const redirectUri = env['OIDC_REDIRECT_URI']?.trim();
  if (!issuer && !clientId && !clientSecret && !redirectUri) return null;
  if (!issuer || !clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'OIDC requires OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and OIDC_REDIRECT_URI together.',
    );
  }
  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    scopes: ['openid', 'profile', 'email'],
    allowInsecureDiscovery: allowsInsecureDiscovery(issuer, env),
  };
}

/**
 * ADR-0161's 2026-11-01 amendment (DI9, issue #2075): whether discovery of `issuer` may use plain
 * `http:`. Only when the deployment posture is `local` **and** the issuer is `http:` on a loopback
 * host, which is `aw dev`'s development issuer on `127.0.0.1`. Everywhere else discovery is
 * `https:` only, as `openid-client` enforces by default; the production posture refuses a
 * non-`https:` issuer at boot (`oidc_issuer_not_https`).
 */
export function allowsInsecureDiscovery(
  issuer: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return false;
  }
  return (
    url.protocol === 'http:' &&
    isLoopbackHost(url.hostname) &&
    readDeploymentPosture(env) === 'local'
  );
}

/**
 * The options every discovery of the configured issuer passes: `allowInsecureRequests` only where
 * {@link allowsInsecureDiscovery} said so when the configuration was read, otherwise none, exactly
 * as before.
 */
export function oidcDiscoveryOptions(
  configuration: DiscoverableOidcConfiguration,
): oidc.DiscoveryRequestOptions | undefined {
  return configuration.allowInsecureDiscovery === true
    ? { execute: [oidc.allowInsecureRequests] }
    : undefined;
}

/**
 * True when the issuer advertises `client_secret_basic` and not `client_secret_post`, the method
 * `openid-client` uses by default. `aw dev`'s development issuer serves Basic only (ADR-0161
 * amendment DI4); an issuer that lists post, or lists nothing, keeps today's method.
 */
function basicOnly(metadata: oidc.ServerMetadata): boolean {
  const methods = metadata.token_endpoint_auth_methods_supported;
  return (
    methods !== undefined &&
    methods.includes('client_secret_basic') &&
    !methods.includes('client_secret_post')
  );
}

async function discover(configuration: DiscoverableOidcConfiguration): Promise<oidc.Configuration> {
  const options = oidcDiscoveryOptions(configuration);
  const discovered = await oidc.discovery(
    new URL(configuration.issuer),
    configuration.clientId,
    configuration.clientSecret,
    undefined,
    options,
  );
  const metadata = discovered.serverMetadata();
  if (!basicOnly(metadata)) return discovered;
  const basic = new oidc.Configuration(
    metadata,
    configuration.clientId,
    configuration.clientSecret,
    oidc.ClientSecretBasic(configuration.clientSecret),
  );
  if (options !== undefined) oidc.allowInsecureRequests(basic);
  return basic;
}

/** What the transaction cookie carries beyond the PKCE pair: where to land after sign-in. */
export type OidcLoginResult = OidcIdentity & {
  /** The signed-in destination as `beginOidcLogin` was given it; the caller re-validates it. */
  readonly next?: string | null;
};

/** The transaction's own key, derived from the secret (part 06 step 5, `./core/key-ring.ts`). */
function transactionKey(signingSecret: string): Promise<Uint8Array<ArrayBuffer>> {
  return derivePurposeKey(crypto.subtle, signingSecret, 'oidc-transaction');
}

/**
 * The purpose key, then the raw secret every transaction was signed with before step 5, so a
 * sign-in that began before a deploy still finishes. Only a bad signature moves on to the next
 * key; an expired or malformed transaction is refused as it was.
 */
async function verifyTransaction(token: string, signingSecret: string): Promise<JWTVerifyResult> {
  const keys = verificationKeys(
    () => transactionKey(signingSecret),
    () => Promise.resolve(encoder.encode(signingSecret)),
  );
  for (const [index, key] of keys.entries()) {
    try {
      return await jwtVerify(token, await key(), { algorithms: ['HS256'] });
    } catch (error) {
      const lastKey = index === keys.length - 1;
      if (lastKey || !(error instanceof errors.JWSSignatureVerificationFailed)) throw error;
    }
  }
  throw new Error('OIDC transaction has no verification key.');
}

/** `next` must already have passed `safeNextPath`; it rides in the signed transaction. */
export async function beginOidcLogin(
  configuration: DiscoverableOidcConfiguration,
  signingSecret: string,
  nowMs: number = systemClock.now().getTime(),
  next: string | null = null,
): Promise<{ readonly url: URL; readonly transaction: string }> {
  const client = await discover(configuration);
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const state = oidc.randomState();
  const url = oidc.buildAuthorizationUrl(client, {
    redirect_uri: configuration.redirectUri,
    scope: configuration.scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    response_mode: 'form_post',
  });
  const transaction = await new SignJWT(
    next === null ? { verifier, state } : { verifier, state, next },
  )
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(Math.floor(nowMs / 1000))
    .setExpirationTime(Math.floor(nowMs / 1000) + TRANSACTION_TTL_SECONDS)
    .sign(await transactionKey(signingSecret));
  return { url, transaction };
}

export async function finishOidcLogin(
  configuration: DiscoverableOidcConfiguration,
  signingSecret: string,
  callbackUrl: URL,
  transactionToken: string,
): Promise<OidcLoginResult> {
  const verified = await verifyTransaction(transactionToken, signingSecret);
  const verifier = verified.payload['verifier'];
  const state = verified.payload['state'];
  const next = verified.payload['next'];
  if (typeof verifier !== 'string' || typeof state !== 'string')
    throw new Error('OIDC transaction is malformed.');
  const client = await discover(configuration);
  const tokens = await oidc.authorizationCodeGrant(client, callbackUrl, {
    pkceCodeVerifier: verifier,
    expectedState: state,
  });
  const claims = tokens.claims();
  const subject = claims?.['sub'];
  const email = claims?.['email'];
  const name = claims?.['name'];
  if (typeof subject !== 'string' || typeof email !== 'string') {
    throw new Error('OIDC identity token must contain sub and email claims.');
  }
  // An unverified email is whatever the user typed at the provider; matching or minting on it is
  // account takeover by email change ("nOAuth").
  if (claims?.['email_verified'] !== true) {
    throw new Error('OIDC identity token must carry email_verified: true.');
  }
  return {
    subject,
    email: email.toLowerCase(),
    name: typeof name === 'string' ? name : null,
    next: typeof next === 'string' ? next : null,
  };
}
