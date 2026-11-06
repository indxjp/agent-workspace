/**
 * `POST /oauth/token` (RFC 6749, OAuth 2.1 subset; ADR-0134 part 3): `authorization_code` with
 * PKCE `S256`, `client_credentials` for a confidential client, and `refresh_token` with rotation.
 * A code or refresh token presented twice is theft: the whole family is revoked.
 */
import { closeEndpointToolSandbox } from '../tool-endpoint/close';
import { authenticateClient } from './client-auth';
import { oauthError, oauthJson, type OAuthErrorCode } from './http';
import { resourceUrl } from './resource';
import type { OAuthClient, OAuthRuntime } from './runtime';
import type { OAuthTokenRows } from './store';
import {
  mintOAuthToken,
  OAUTH_TOKEN_TTL_MS,
  oauthTokenHash,
  verifyPkceS256,
  type OAuthTokenKind,
} from './tokens';

export const OAUTH_SCOPE = 'endpoint';

interface Grant {
  readonly subjectPrincipalId: string;
  readonly resource: string;
  readonly familyId: string;
}

const refusal = (error: OAuthErrorCode, description: string): Response =>
  oauthError(400, error, description);
const invalidGrant = (): Response =>
  refusal('invalid_grant', 'The grant is invalid, expired or spent.');

async function issue(
  tokens: OAuthTokenRows,
  client: OAuthClient,
  grant: Grant,
  kind: Exclude<OAuthTokenKind, 'code'>,
): Promise<string> {
  const minted = await mintOAuthToken(kind);
  await tokens.issue({
    id: crypto.randomUUID(),
    clientId: client.id,
    kind,
    tokenHash: minted.tokenHash,
    subjectPrincipalId: grant.subjectPrincipalId,
    resource: grant.resource,
    familyId: grant.familyId,
    expiresAt: new Date(Date.now() + OAUTH_TOKEN_TTL_MS[kind]),
  });
  return minted.presented;
}

async function respond(
  runtime: OAuthRuntime,
  client: OAuthClient,
  grant: Grant,
  grantType: string,
  withRefresh: boolean,
): Promise<Response> {
  const tokens = await runtime.tokens(client.workspaceId);
  const accessToken = await issue(tokens, client, grant, 'access');
  const refreshToken = withRefresh ? await issue(tokens, client, grant, 'refresh') : null;
  await runtime.audit(client.workspaceId, grant.subjectPrincipalId, {
    action: 'oauth-grant-issued',
    clientId: client.id,
    clientName: client.name,
    detail: grantType,
  });
  return oauthJson(200, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: OAUTH_TOKEN_TTL_MS.access / 1000,
    ...(refreshToken === null ? {} : { refresh_token: refreshToken }),
    scope: OAUTH_SCOPE,
  });
}

/** Spend a code or refresh token; a spent one revokes its family. */
async function spend(
  runtime: OAuthRuntime,
  client: OAuthClient,
  kind: 'code' | 'refresh',
  presented: string | null,
) {
  const tokenHash = presented === null ? null : await oauthTokenHash(kind, presented);
  if (tokenHash === null) return null;
  const tokens = await runtime.tokens(client.workspaceId);
  const outcome = await tokens.consume(kind, tokenHash, client.id);
  if (outcome.kind === 'reused') {
    await tokens.revokeFamily(outcome.familyId);
    await runtime.audit(client.workspaceId, outcome.subjectPrincipalId, {
      action: 'oauth-grant-revoked',
      clientId: client.id,
      clientName: client.name,
      detail: 'reuse',
    });
    if (client.kind === 'mcp-project') {
      await closeEndpointToolSandbox(client.workspaceId, client.id);
    }
  }
  return outcome.kind === 'consumed' ? outcome.token : null;
}

export async function token(request: Request): Promise<Response> {
  const auth = await authenticateClient(request);
  if (!auth.ok) return auth.response;
  const { client, form, runtime } = auth;
  // ADR-0161 D4: an app-backend client's tokens come from the ID-token exchange alone; a grant here
  // would act for the client's creator, and it has no resource URL.
  if (client.kind === 'app-backend') {
    return refusal(
      'unauthorized_client',
      'An app-backend client exchanges ID tokens at /api/auth/token-exchange.',
    );
  }

  const scope = form.get('scope');
  if (scope !== null && scope.trim() !== OAUTH_SCOPE) {
    return refusal('invalid_scope', `The only scope is "${OAUTH_SCOPE}".`);
  }
  const grantType = form.get('grant_type');
  const requestedResource = form.get('resource');
  const resourceMismatch = (expected: string): boolean =>
    requestedResource !== null && requestedResource !== expected;
  const wrongTarget = (): Response =>
    refusal('invalid_target', "resource must be the client's resource URL.");

  switch (grantType) {
    case 'authorization_code': {
      const code = await spend(runtime, client, 'code', form.get('code'));
      const verifier = form.get('code_verifier');
      if (code === null || code.codeChallenge === null) return invalidGrant();
      if (form.get('redirect_uri') !== code.redirectUri) return invalidGrant();
      if (verifier === null || !(await verifyPkceS256(verifier, code.codeChallenge))) {
        return invalidGrant();
      }
      if (resourceMismatch(code.resource)) return wrongTarget();
      return respond(
        runtime,
        client,
        {
          subjectPrincipalId: code.subjectPrincipalId,
          resource: code.resource,
          familyId: code.familyId,
        },
        grantType,
        true,
      );
    }
    case 'refresh_token': {
      const refresh = await spend(runtime, client, 'refresh', form.get('refresh_token'));
      if (refresh === null) return invalidGrant();
      if (resourceMismatch(refresh.resource)) return wrongTarget();
      return respond(
        runtime,
        client,
        {
          subjectPrincipalId: refresh.subjectPrincipalId,
          resource: refresh.resource,
          familyId: refresh.familyId,
        },
        grantType,
        true,
      );
    }
    case 'client_credentials': {
      // The token's subject would be the member who created the client, with nobody consenting.
      if (client.kind === 'builder') {
        return refusal('unauthorized_client', 'A builder client is authorized by a member.');
      }
      if (client.clientSecretHash === null) {
        return refusal('unauthorized_client', 'client_credentials needs a confidential client.');
      }
      const resource = client.resourcePath === null ? null : resourceUrl(client.resourcePath);
      if (resource === null) return wrongTarget();
      if (resourceMismatch(resource)) return wrongTarget();
      return respond(
        runtime,
        client,
        {
          subjectPrincipalId: client.actsForPrincipalId,
          resource,
          familyId: crypto.randomUUID(),
        },
        grantType,
        false,
      );
    }
    default:
      return refusal(
        'unsupported_grant_type',
        'Use authorization_code, refresh_token or client_credentials.',
      );
  }
}
