import * as oidc from 'openid-client';
import { SignJWT, jwtVerify } from 'jose';

import type { OidcConfiguration, OidcIdentity } from '@agent-workspace/core/auth';

const encoder = new TextEncoder();
/** The unscoped base name; routes use `oidcTransactionCookieName()` from `index.ts` (issue #394). */
export const OIDC_TRANSACTION_COOKIE_BASE_NAME = 'aw_oidc_transaction';
const TRANSACTION_TTL_SECONDS = 600;

export interface OidcTransaction {
  readonly verifier: string;
  readonly state: string;
  readonly expiresAt: number;
}

export function readOidcConfiguration(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OidcConfiguration | null {
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
  return { issuer, clientId, clientSecret, redirectUri, scopes: ['openid', 'profile', 'email'] };
}

async function discover(configuration: OidcConfiguration): Promise<oidc.Configuration> {
  return oidc.discovery(
    new URL(configuration.issuer),
    configuration.clientId,
    configuration.clientSecret,
  );
}

/** What the transaction cookie carries beyond the PKCE pair: where to land after sign-in. */
export type OidcLoginResult = OidcIdentity & {
  /** The signed-in destination as `beginOidcLogin` was given it; the caller re-validates it. */
  readonly next?: string | null;
};

/** `next` must already have passed `safeNextPath`; it rides in the signed transaction. */
export async function beginOidcLogin(
  configuration: OidcConfiguration,
  signingSecret: string,
  nowMs: number = Date.now(),
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
    .sign(encoder.encode(signingSecret));
  return { url, transaction };
}

export async function finishOidcLogin(
  configuration: OidcConfiguration,
  signingSecret: string,
  callbackUrl: URL,
  transactionToken: string,
): Promise<OidcLoginResult> {
  const verified = await jwtVerify(transactionToken, encoder.encode(signingSecret), {
    algorithms: ['HS256'],
  });
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
