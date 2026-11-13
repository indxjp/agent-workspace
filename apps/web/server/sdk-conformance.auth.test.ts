/**
 * SDK conformance, auth: see `sdk-conformance.test-support.ts` for what this suite pins.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { servedContractsHeaders } from './versioning/contracts-version';
import { ApiProblemError, createClient } from '@indx-workspace/sdk';
import {
  MeResponseSchema,
  PRINCIPAL_KINDS as WIRE_PRINCIPAL_KINDS,
  type PrincipalKindName,
} from '@indx-workspace/contracts/team';
import {
  OAUTH_ACCESS_TOKEN_PATTERN,
  TOKEN_EXCHANGE_PROBLEM_CODES,
  TOKEN_EXCHANGE_TTL_SECONDS,
} from '@indx-workspace/contracts/token-exchange';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { mintSessionToken, newSessionClaims, verifySessionToken } from './auth/session';
import { readMe, wireKind, type WirePrincipalKind } from './rbac/me';
import { toResponse as toRbacResponse } from './rbac/http';
import { exchangeToken } from './auth/token-exchange';
import type { OAuthClient } from './oauth/runtime';
import { mintClientSecret } from './oauth/tokens';
import { resetOAuthLimits } from './oauth/limits';
import { Principal, PRINCIPAL_KINDS as SERVER_PRINCIPAL_KINDS } from './rbac/principal';
import { TEST_WORKSPACE_ID } from './rbac/testing';
import { clearApplicationContext } from './application-context';
import { installTestDomains } from './application-context-fixtures';
import { AGENT } from './sdk-conformance.test-support';

const ISSUER = 'https://idp.example';

const AUDIENCE = 'portal-web';

const ENV = {
  OIDC_ISSUER_URL: ISSUER,
  OIDC_CLIENT_ID: 'platform-browser',
  OIDC_CLIENT_SECRET: 'browser-secret',
  OIDC_REDIRECT_URI: 'https://aw.example.com/api/auth/callback',
};

const CLIENT_ID = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';

/** Registers the one OAuth client the exchange tests act as, and one member the issuer knows. */
function installExchangeOAuth(client: OAuthClient): void {
  installTestDomains({
    oauth: {
      findClient: (id) => Promise.resolve(id === client.id ? client : null),
      canRunAll: () => Promise.resolve(false),
      agentNames: () => Promise.resolve(null),
      tokens: () => Promise.reject(new Error('the exchange writes through issueExchanged')),
      audit: () => Promise.reject(new Error('the exchange writes through issueExchanged')),
      findMember: (workspaceId, issuer, subject) =>
        Promise.resolve(
          workspaceId === TEST_WORKSPACE_ID && issuer === ISSUER && subject === 'member-sub'
            ? { userId: 'user-1', principalId: 'pr-1', label: 'Ada' }
            : null,
        ),
      issueExchanged: () => Promise.resolve(),
    },
  });
}

/** An SDK client whose `fetch` is the real exchange handler, verifying tokens against `jwks`. */
function exchangeClient(jwks: { readonly keys: JWK[] }): ReturnType<typeof createClient> {
  return createClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'session' },
    fetch: async (input, init) => {
      const response = toRbacResponse(
        await exchangeToken(new Request(input, init), {
          env: ENV,
          loadKeySource: () =>
            Promise.resolve({
              issuer: ISSUER,
              algorithms: ['RS256'],
              keys: createLocalJWKSet(jwks),
            }),
        }),
      );
      for (const [name, value] of Object.entries(servedContractsHeaders())) {
        response.headers.set(name, value);
      }
      return response;
    },
  });
}

/** Signs an ID token for `subject` with the issuer's private key. */
function idTokenSigner(privateKey: CryptoKey): (subject: string) => Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return (subject) =>
    new SignJWT({
      iss: ISSUER,
      sub: subject,
      aud: AUDIENCE,
      iat: now - 10,
      exp: now + 600,
      email: 'ada@example.com',
      email_verified: true,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .sign(privateKey);
}

/**
 * The SDK's `aw.auth.exchange` driven against the real handler: the Basic header the SDK builds
 * is what `client-auth.ts` reads, and the body the handler renders is what the SDK validates. The
 * issuer is a local `jose` key pair; nothing reaches the network.
 */
async function exchangeWorld(): Promise<{
  readonly aw: ReturnType<typeof createClient>;
  readonly secret: string;
  readonly idToken: (subject: string) => Promise<string>;
}> {
  resetOAuthLimits();
  const pair = await generateKeyPair('RS256', { extractable: true });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }] };
  const minted = await mintClientSecret();
  installExchangeOAuth({
    id: CLIENT_ID,
    workspaceId: TEST_WORKSPACE_ID,
    name: 'portal',
    kind: 'app-backend',
    actsForPrincipalId: 'creator',
    clientSecretHash: minted.secretHash,
    redirectUris: [],
    oidcAudience: AUDIENCE,
    agentIds: [AGENT],
    resourcePath: null,
  });
  return {
    aw: exchangeClient(jwks),
    secret: minted.presented,
    idToken: idTokenSigner(pair.privateKey),
  };
}

const ME_WORKSPACE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const ME_WORKSPACE_SLUG = 'me-conformance';

const ME_EMAIL = 'member@me.example.test';

const ME_SESSION_SECRET = 'me-conformance-session-secret-that-is-long-enough';

/** A real session principal, built the only way one can be built. */
async function meSessionPrincipal(): Promise<Principal> {
  const token = await mintSessionToken(
    newSessionClaims(ME_EMAIL, ME_WORKSPACE_SLUG),
    ME_SESSION_SECRET,
  );
  const verified = await verifySessionToken(token, ME_SESSION_SECRET);
  if (!verified.ok) throw new Error(`session could not be verified: ${verified.reason}`);
  const built = Principal.fromSession(
    verified.claims,
    { id: ME_WORKSPACE, slug: ME_WORKSPACE_SLUG },
    'admin',
    {
      principalId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      label: 'Aya Ito',
    },
  );
  if (!built.ok) throw new Error(`principal could not be built: ${built.because}`);
  return built.principal;
}

function meApiKeyPrincipal(): Principal {
  return Principal.fromApiKey({
    principalId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    apiKeyId: 'abababab-abab-4bab-8bab-abababababab',
    workspaceId: ME_WORKSPACE,
    role: 'viewer',
    label: 'ci',
  });
}

describe('auth.exchange (ADR-0161)', () => {
  afterEach(() => {
    clearApplicationContext();
  });

  it('the real handler accepts the SDK request and renders a body the SDK accepts', async () => {
    const { aw, secret, idToken } = await exchangeWorld();
    const exchanged = await aw.auth.exchange({
      clientId: CLIENT_ID,
      clientSecret: secret,
      idToken: await idToken('member-sub'),
    });
    expect(exchanged.access_token).toMatch(OAUTH_ACCESS_TOKEN_PATTERN);
    expect(exchanged.expires_in).toBe(TOKEN_EXCHANGE_TTL_SECONDS);
  });

  it('surfaces each handler refusal as the typed error under the contract status', async () => {
    const { aw, secret, idToken } = await exchangeWorld();
    const cases: readonly [string, string, keyof typeof TOKEN_EXCHANGE_PROBLEM_CODES][] = [
      [secret, 'stranger-sub', 'subject_not_member'],
      [`${secret}x`, 'member-sub', 'invalid_client'],
    ];
    for (const [clientSecret, subject, code] of cases) {
      const failure: unknown = await aw.auth
        .exchange({ clientId: CLIENT_ID, clientSecret, idToken: await idToken(subject) })
        .catch((error: unknown) => error);
      expect(failure, code).toBeInstanceOf(ApiProblemError);
      expect((failure as ApiProblemError).code).toBe(code);
      expect((failure as ApiProblemError).status).toBe(TOKEN_EXCHANGE_PROBLEM_CODES[code]);
    }
  });
});

describe('me', () => {
  it('renders both principal kinds through the real serializer into bodies the contract accepts', async () => {
    for (const principal of [await meSessionPrincipal(), meApiKeyPrincipal()]) {
      const result = readMe(principal, ['chat', 'runs']);
      expect(result.status).toBe(200);
      const parsed = MeResponseSchema.safeParse(result.body);
      expect(
        parsed.success,
        `the ${principal.kind} body does not satisfy MeResponseSchema: ${JSON.stringify(parsed)}`,
      ).toBe(true);
      if (!parsed.success) continue;
      expect(parsed.data.workspaceId).toBe(ME_WORKSPACE);
      expect(parsed.data.features).toEqual(['chat', 'runs']);
      // The wire's own promise about the field the two kinds differ in.
      expect(parsed.data.userId === null).toBe(principal.kind === 'api_key');
    }
  });

  it('keeps the server’s principal-kind vocabulary and the contract’s in correspondence', () => {
    // `MeResponseSchema` is `.strict()` and `kind` is an enum, so the assertion above would catch
    // a server kind the contract has not got — but only for the two kinds the fixtures above
    // happen to build. This one quantifies over the server's whole list, mapped through the same
    // `wireKind` the route uses, and asserts the mapping is onto the contract's whole list. A
    // third principal kind, or a rename on either side, fails here.
    expect(SERVER_PRINCIPAL_KINDS.map(wireKind)).toEqual([...WIRE_PRINCIPAL_KINDS]);
    expect(new Set(SERVER_PRINCIPAL_KINDS.map(wireKind)).size).toBe(WIRE_PRINCIPAL_KINDS.length);
    // The compile-time half, which the runtime comparison cannot make: a wire kind the contract
    // has not got would still be a string.
    const serverCoversContract: WirePrincipalKind extends PrincipalKindName ? true : false = true;
    const contractCoversServer: PrincipalKindName extends WirePrincipalKind ? true : false = true;
    expect([serverCoversContract, contractCoversServer]).toEqual([true, true]);
  });
});
