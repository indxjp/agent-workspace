import { describe, expect, it, vi } from 'vitest';
import { GET as AS_METADATA } from '../../app/.well-known/oauth-authorization-server/route';
import { GET as A2A_METADATA } from '../../app/.well-known/oauth-protected-resource/api/a2a/agents/[agentName]/route';
import { GET as BUILDER_METADATA } from '../../app/.well-known/oauth-protected-resource/mcp/builder/route';
import { GET as MCP_METADATA } from '../../app/.well-known/oauth-protected-resource/mcp/projects/[name]/route';
import { POST as TOKEN } from '../../app/oauth/token/route';
import { installTestDomains } from '../application-context-fixtures';
import {
  A2A_RESOURCE,
  authorizeGet,
  authorizeParams,
  MCP_RESOURCE,
  ORIGIN,
  send,
  tokenRequest,
} from './oauth-server.test-support';

describe('discovery documents', () => {
  it(
    'serves RFC 8414 metadata that offers PKCE S256 only',
    servesRFC8414MetadataThatOffersPKCES256,
  );

  it(
    'serves RFC 9728 metadata for both resource kinds without touching the database',
    servesRFC9728MetadataBothResourceKindsWithout,
  );

  it(
    'publishes the Builder resource at its exact path only',
    publishesBuilderResourceAtExactPathOnly,
  );

  it('answers 404 for a path that is not a resource', answers404PathThatIsNotResource);

  it(
    'answers 404 oauth_not_configured when AW_PUBLIC_URL is unset',
    answers404OauthNotConfiguredWhenAWPUBLIC,
  );
});

async function servesRFC8414MetadataThatOffersPKCES256() {
  const out = await send(
    new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
    AS_METADATA,
  );
  expect(out.response.status).toBe(200);
  expect(out.response.headers.get('cache-control')).toBe('public, max-age=300');
  expect(out.json()).toMatchObject({
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/oauth/authorize`,
    token_endpoint: `${ORIGIN}/oauth/token`,
    revocation_endpoint: `${ORIGIN}/oauth/revoke`,
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token'],
    authorization_response_iss_parameter_supported: true,
  });
}

async function servesRFC9728MetadataBothResourceKindsWithout() {
  installTestDomains({
    oauth: {
      findClient: () => Promise.reject(new Error('no database')),
      canRunAll: () => Promise.reject(new Error('no database')),
      agentNames: () => Promise.reject(new Error('no database')),
      tokens: () => Promise.reject(new Error('no database')),
      audit: () => Promise.reject(new Error('no database')),
      findMember: () => Promise.reject(new Error('no database')),
      issueExchanged: () => Promise.reject(new Error('no database')),
    },
  });
  const mcpOut = await send(
    new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp/projects/docs`),
    MCP_METADATA,
  );
  expect(mcpOut.json()).toMatchObject({
    resource: MCP_RESOURCE,
    authorization_servers: [ORIGIN],
  });
  const a2aOut = await send(
    new Request(`${ORIGIN}/.well-known/oauth-protected-resource/api/a2a/agents/helper`),
    A2A_METADATA,
  );
  expect(a2aOut.json()).toMatchObject({
    resource: A2A_RESOURCE,
    authorization_servers: [ORIGIN],
  });
  const builderOut = await send(
    new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp/builder`),
    BUILDER_METADATA,
  );
  expect(builderOut.json()).toMatchObject({
    resource: `${ORIGIN}/mcp/builder`,
    authorization_servers: [ORIGIN],
  });
}

async function publishesBuilderResourceAtExactPathOnly() {
  for (const path of ['mcp/builder/x', 'mcp/builders', 'mcp/Builder']) {
    const out = await send(
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource/${path}`),
      BUILDER_METADATA,
    );
    expect(out.response.status, path).toBe(404);
  }
}

async function answers404PathThatIsNotResource() {
  const out = await send(
    new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp/projects/a/b`),
    MCP_METADATA,
  );
  expect(out.response.status).toBe(404);
  expect(out.json()).toMatchObject({ error: 'invalid_target' });
}

async function answers404OauthNotConfiguredWhenAWPUBLIC() {
  vi.stubEnv('AW_PUBLIC_URL', '');
  const meta = await send(
    new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
    AS_METADATA,
  );
  expect(meta.response.status).toBe(404);
  expect(meta.json()).toMatchObject({ error: 'oauth_not_configured' });
  const tok = await send(tokenRequest({ grant_type: 'client_credentials' }), TOKEN);
  expect(tok.response.status).toBe(404);
  const auth = await authorizeGet(authorizeParams());
  expect(auth.response.status).toBe(404);
}
