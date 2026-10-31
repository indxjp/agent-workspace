/**
 * `POST /api/auth/token-exchange` (ADR-0161): an app backend trades the signed-in person's ID token
 * from the deployment's own `OIDC_ISSUER_URL` for a 300-second `awo_live_` access token bound to
 * its `app-backend` endpoint client, acting as that person.
 *
 * The order is fixed so that nothing about the person is read before the token is proved, and
 * nothing about the token is read before the client is:
 *
 * 1. the OIDC configuration and the database runtime (`503 token_exchange_not_configured`);
 * 2. the source address's failed client authentications (`429`), then the client by
 *    `client_secret_basic`, which must be an unrevoked confidential `app-backend` client
 *    (`401 invalid_client`), then the client's own rate (`429`);
 * 3. the body, against the strict contract (`400 invalid_body`);
 * 4. the ID token, by `jose` against the key set of the configured issuer only (the token's
 *    `jku`, `x5u`, `x5c` and `jwk` are never read), then the pure claim checks;
 * 5. the person, by `(OIDC_ISSUER_URL, sub)`, as a member of the client's workspace;
 * 6. one token row and its audit row, in one transaction.
 *
 * Nothing here logs or echoes the ID token, the client secret or the issued token; a refusal is
 * logged by its code and the client id only.
 */
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import * as oidc from 'openid-client';

import { isUuid } from '@indx-workspace/contracts';
import {
  ACCESS_TOKEN_TYPE,
  SUBJECT_TOKEN_MAX_LENGTH,
  TOKEN_EXCHANGE_PROBLEM_CODES,
  TOKEN_EXCHANGE_TTL_SECONDS,
  TokenExchangeRequestSchema,
  type TokenExchangeProblemCode,
  type TokenExchangeResponse,
} from '@indx-workspace/contracts/token-exchange';
import type { OidcConfiguration } from '@agent-workspace/core/auth';

import { applicationContext } from '../application-context';
import { formatIssues, problem, readJsonBody, type ApiResult } from '../http/result';
import { perMinuteLimiter, type Admission } from '../http/rate-limit';
import { readBasic } from '../oauth/client-auth';
import { admitOAuthAuthAttempt, OAUTH_RATE_LIMITS, recordOAuthAuthFailure } from '../oauth/limits';
import type { OAuthClient } from '../oauth/runtime';
import { clientSecretDigest, mintOAuthToken } from '../oauth/tokens';
import { hashesEqual } from '../rbac/api-key';
import { log } from '../telemetry/logger';
import { readOidcConfiguration } from './oidc';
import {
  claimsRefusal,
  clientRefusal,
  decideExchange,
  ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
  type ExchangeClient,
} from './token-exchange-decision';

/**
 * ADR-0161 D12. The failed client authentications of an address are the OAuth server's own counter
 * (`../oauth/limits.ts`), so alternating between `/oauth/token` and this route buys no extra
 * guesses at a secret. shortcut: per-process counters, so each replica admits its own limit and a
 * restart resets them; move them to PostgreSQL when the control plane runs more than one replica.
 */
export const TOKEN_EXCHANGE_RATE_LIMITS = {
  perClientPerMinute: 120,
  failedAuthPerAddressPerMinute: OAUTH_RATE_LIMITS.failedAuthPerAddressPerMinute,
} as const;

const byClient = perMinuteLimiter(TOKEN_EXCHANGE_RATE_LIMITS.perClientPerMinute);

/** For tests: forget this route's per-client counter (the OAuth module resets the shared one). */
export function resetTokenExchangeLimits(): void {
  byClient.clear();
}

/** ADR-0161 D5 step 1: the asymmetric algorithms an ID token may be signed with. */
export const ID_TOKEN_ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA'] as const;

/**
 * Where the issuer's signing keys come from (ADR-0161 D5 step 2): fixed by configuration, never by
 * the token. Production discovers them from `OIDC_ISSUER_URL`; a test passes a local key set.
 */
export interface IdTokenKeySource {
  /** The issuer discovery validated for `OIDC_ISSUER_URL`: the only `iss` accepted. */
  readonly issuer: string;
  /** The issuer's advertised `id_token_signing_alg_values_supported`, before the asymmetric filter. */
  readonly algorithms: readonly string[];
  /** The key set; `jose` picks a key from it by the header's `kid` alone. */
  readonly keys: JWTVerifyGetKey;
}

export type IdTokenKeySourceLoader = (
  configuration: OidcConfiguration,
) => Promise<IdTokenKeySource>;

/** OIDC Core §3.1.3.7: RS256 is the default when the issuer advertises nothing. */
const DEFAULT_ALGORITHMS: readonly string[] = ['RS256'];

/** An unknown `kid` re-reads the key set at most this often (ADR-0161 D5 step 2). */
const JWKS_COOLDOWN_MS = 30_000;

const discovered = new Map<string, Promise<IdTokenKeySource>>();

/**
 * The production key source: OIDC discovery of the configured issuer through `openid-client`, the
 * same discovery the browser sign-in uses, and `jose`'s remote key set at the discovered
 * `jwks_uri`. Cached per process by issuer; a failed discovery is not cached.
 */
export const discoverIdTokenKeySource: IdTokenKeySourceLoader = (configuration) => {
  const cached = discovered.get(configuration.issuer);
  if (cached !== undefined) return cached;
  const loading = (async (): Promise<IdTokenKeySource> => {
    const client = await oidc.discovery(
      new URL(configuration.issuer),
      configuration.clientId,
      configuration.clientSecret,
    );
    const metadata = client.serverMetadata();
    if (metadata.jwks_uri === undefined) {
      throw new Error('the OIDC issuer advertises no jwks_uri');
    }
    return {
      issuer: metadata.issuer,
      algorithms: metadata.id_token_signing_alg_values_supported ?? DEFAULT_ALGORITHMS,
      keys: createRemoteJWKSet(new URL(metadata.jwks_uri), {
        cooldownDuration: JWKS_COOLDOWN_MS,
      }),
    };
  })();
  discovered.set(configuration.issuer, loading);
  loading.catch(() => discovered.delete(configuration.issuer));
  return loading;
};

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The seams a test replaces: where the keys come from, the clock and the environment. Without
 * `env`, the OIDC configuration and the address limit read the process environment through their
 * own modules' defaults.
 */
export interface TokenExchangeDependencies {
  readonly loadKeySource?: IdTokenKeySourceLoader;
  readonly now?: () => Date;
  readonly env?: Environment;
}

/** ADR-0161 D12: the token's audience, an absolute URI that is never an endpoint's URL. */
export function appBackendResource(clientId: string): string {
  return `urn:agent-workspace:app-backend:${clientId}`;
}

/** The body this route reads: the ID token plus its JSON envelope, never more. */
const MAX_EXCHANGE_BODY_BYTES = SUBJECT_TOKEN_MAX_LENGTH + 1024;

const MESSAGES: Readonly<Record<TokenExchangeProblemCode, string>> = {
  token_exchange_not_configured: 'This deployment does not exchange ID tokens.',
  invalid_client: 'Client authentication failed.',
  subject_token_invalid: 'The ID token is not valid.',
  subject_token_wrong_issuer: "The ID token was not issued by this deployment's identity provider.",
  subject_token_wrong_audience: 'The ID token was not issued for this client.',
  subject_not_member: 'The signed-in person is not a member of this workspace.',
  rate_limited: 'Too many requests.',
};

function refusal(
  code: TokenExchangeProblemCode,
  clientId: string | null,
  headers: Readonly<Record<string, string>> = {},
): ApiResult {
  // The code and the client id only: never the ID token, the secret or a claim.
  log.info('[token-exchange] refused', { code, clientId });
  return {
    ...problem(TOKEN_EXCHANGE_PROBLEM_CODES[code], code, MESSAGES[code]),
    headers: { ...headers, pragma: 'no-cache' },
  };
}

const rateLimited = (
  admission: Extract<Admission, { admitted: false }>,
  clientId: string | null,
): ApiResult =>
  refusal('rate_limited', clientId, { 'retry-after': String(admission.retryAfterSeconds) });

type Authenticated =
  | { readonly ok: true; readonly client: OAuthClient }
  | { readonly ok: false; readonly result: ApiResult };

function exchangeClientOf(client: OAuthClient): ExchangeClient {
  return {
    kind: client.kind,
    oidcAudience: client.oidcAudience,
    hasClientSecret: client.clientSecretHash !== null,
    revoked: false,
  };
}

/**
 * Authenticate the client by `client_secret_basic` only (ADR-0161 D3). A failure counts against
 * the source address, checked before the secret; the client's own rate is counted only after it
 * proved itself, so naming a public `client_id` locks nobody out.
 */
async function authenticate(
  request: Request,
  findClient: (id: string) => Promise<OAuthClient | null>,
  env: Environment | undefined,
  nowMs: number,
): Promise<Authenticated> {
  const attempt =
    env === undefined
      ? admitOAuthAuthAttempt(request.headers, nowMs)
      : admitOAuthAuthAttempt(request.headers, nowMs, env);
  if (!attempt.admitted) return { ok: false, result: rateLimited(attempt, null) };
  const failed = (clientId: string | null): Authenticated => {
    if (env === undefined) recordOAuthAuthFailure(request.headers, nowMs);
    else recordOAuthAuthFailure(request.headers, nowMs, env);
    return {
      ok: false,
      result: refusal('invalid_client', clientId, {
        'www-authenticate': 'Basic realm="agent-workspace"',
      }),
    };
  };
  const basic = readBasic(request.headers.get('authorization'));
  if (basic === undefined || basic === null) return failed(null);
  const clientId = isUuid(basic.id) ? basic.id : null;
  const client = clientId === null ? null : await findClient(clientId);
  if (client === null || client.clientSecretHash === null) return failed(clientId);
  const digest = await clientSecretDigest(basic.secret);
  if (digest === null || !hashesEqual(digest, client.clientSecretHash)) return failed(client.id);
  if (clientRefusal(exchangeClientOf(client)) !== null) return failed(client.id);
  const counted = byClient.admit(client.id, nowMs);
  if (!counted.admitted) return { ok: false, result: rateLimited(counted, client.id) };
  return { ok: true, client };
}

type Verified =
  | { readonly ok: true; readonly claims: Record<string, unknown> }
  | { readonly ok: false; readonly code: TokenExchangeProblemCode };

/**
 * D5 steps 1 to 5 by `jose`: shape, an asymmetric algorithm the issuer advertises, the signature
 * against the configured key set, `iss`, `aud` and `exp`. Every refusal of the token itself is a
 * named code; a failure to reach the key set is not the caller's and is rethrown.
 */
async function verifyIdToken(
  token: string,
  source: IdTokenKeySource,
  audience: string,
  now: Date,
): Promise<Verified> {
  const allowed: readonly string[] = ID_TOKEN_ALGORITHMS;
  const algorithms = source.algorithms.filter((alg) => allowed.includes(alg));
  try {
    const { payload } = await jwtVerify(token, source.keys, {
      issuer: source.issuer,
      audience,
      algorithms,
      clockTolerance: ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
      currentDate: now,
      requiredClaims: ['exp', 'iat', 'sub'],
    });
    return { ok: true, claims: payload };
  } catch (error) {
    if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) throw error;
    if (error instanceof errors.JWTClaimValidationFailed) {
      if (error.claim === 'iss') return { ok: false, code: 'subject_token_wrong_issuer' };
      if (error.claim === 'aud') return { ok: false, code: 'subject_token_wrong_audience' };
      return { ok: false, code: 'subject_token_invalid' };
    }
    if (error instanceof errors.JOSEError) return { ok: false, code: 'subject_token_invalid' };
    throw error;
  }
}

const notConfigured = (): ApiResult => refusal('token_exchange_not_configured', null);

const unavailable = (clientId: string, error: unknown): ApiResult => {
  log.error('[token-exchange] the identity provider could not be reached', { clientId, error });
  return problem(
    503,
    'service_unavailable',
    'The identity provider could not be reached. Try again shortly.',
  );
};

/** The handler. Every answer is `no-store`; the route only maps the result. */
export async function exchangeToken(
  request: Request,
  dependencies: TokenExchangeDependencies = {},
): Promise<ApiResult> {
  const { env } = dependencies;
  const now = (dependencies.now ?? (() => new Date()))();
  let configuration: OidcConfiguration | null;
  try {
    configuration = env === undefined ? readOidcConfiguration() : readOidcConfiguration(env);
  } catch {
    configuration = null;
  }
  const runtime = applicationContext()?.oauth ?? null;
  if (configuration === null || runtime === null) return notConfigured();

  const auth = await authenticate(request, (id) => runtime.findClient(id), env, now.getTime());
  if (!auth.ok) return auth.result;
  const { client } = auth;
  if (client.oidcAudience === null) return refusal('invalid_client', client.id);

  const raw = await readJsonBody(request, MAX_EXCHANGE_BODY_BYTES);
  if (!raw.ok) return raw.result;
  const parsed = TokenExchangeRequestSchema.safeParse(raw.value);
  if (!parsed.success) {
    return problem(
      400,
      'invalid_body',
      'The body is not a token exchange request.',
      formatIssues(parsed.error.issues),
    );
  }

  let source: IdTokenKeySource;
  let verified: Verified;
  try {
    source = await (dependencies.loadKeySource ?? discoverIdTokenKeySource)(configuration);
    verified = await verifyIdToken(parsed.data.subject_token, source, client.oidcAudience, now);
  } catch (error) {
    return unavailable(client.id, error);
  }
  if (!verified.ok) return refusal(verified.code, client.id);
  const early = claimsRefusal(verified.claims, client.oidcAudience, now);
  if (early !== null) return refusal(early.code, client.id);

  const subject = verified.claims['sub'];
  const member =
    typeof subject === 'string'
      ? await runtime.findMember(client.workspaceId, configuration.issuer, subject)
      : null;
  const decision = decideExchange({
    client: exchangeClientOf(client),
    claims: verified.claims,
    member,
    now,
  });
  if (decision.kind === 'refuse' || member === null) {
    return refusal(decision.kind === 'refuse' ? decision.code : 'subject_not_member', client.id);
  }

  const minted = await mintOAuthToken('access');
  await runtime.issueExchanged(client, member, {
    id: crypto.randomUUID(),
    tokenHash: minted.tokenHash,
    familyId: crypto.randomUUID(),
    resource: appBackendResource(client.id),
    expiresAt: decision.expiresAt,
  });
  const body: TokenExchangeResponse = {
    access_token: minted.presented,
    issued_token_type: ACCESS_TOKEN_TYPE,
    token_type: 'Bearer',
    expires_in: TOKEN_EXCHANGE_TTL_SECONDS,
  };
  return { status: 200, body, headers: { pragma: 'no-cache' } };
}
