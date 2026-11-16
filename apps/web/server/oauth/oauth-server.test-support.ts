import { afterEach, beforeEach, expect, vi } from 'vitest';
import { GET as AUTHORIZE_GET, POST as AUTHORIZE_POST } from '../../app/oauth/authorize/route';
import { POST as TOKEN } from '../../app/oauth/token/route';
import { clearApplicationContext } from '../application-context';
import { clearClientIdentity } from '../client-identity';
import { installTestDomains } from '../application-context-fixtures';
import { Principal } from '../rbac/principal';
import {
  callerHeaders,
  installRbacHarness,
  TEST_WORKSPACE_ID,
  type RbacHarness,
} from '../rbac/testing';
import { resetOAuthLimits } from './limits';
import { fakeTokens, type Row } from './oauth-server.tokens.test-support';
import { BUILDER_RESOURCE_PATH } from './resource';
import type { OAuthAuditEvent, OAuthClient } from './runtime';
import { mintClientSecret } from './tokens';

export const ORIGIN = 'https://aw.example';

export const REDIRECT = 'https://app.example/callback';

export const MCP_RESOURCE = `${ORIGIN}/mcp/projects/docs`;

export const A2A_RESOURCE = `${ORIGIN}/api/a2a/agents/helper`;

export const BUILDER_RESOURCE = `${ORIGIN}/mcp/builder`;

export const OTHER_WORKSPACE = 'some-other-workspace';

export const PROXY_TEST_SECRET = 'a-secure-test-secret-with-at-least-32-characters';

export const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

export const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

export const ownerCaller = { email: 'owner@example.com' };

export const viewerCaller = { email: 'viewer@example.com' };

let harness: RbacHarness;

let ownerId: string;

let viewerId: string;

let rows: Row[];

let audits: { workspaceId: string; actor: string; event: OAuthAuditEvent }[];

let clients: Map<string, OAuthClient>;

let cannotRun: Set<string>;

let agentGone: boolean;

let secret: string;

let mcp: OAuthClient;

let a2a: OAuthClient;

let builder: OAuthClient;

let builderConfidential: OAuthClient;

let foreign: OAuthClient;

let bodies: string[];

export function client(over: Partial<OAuthClient> & Pick<OAuthClient, 'id' | 'name'>): OAuthClient {
  return {
    workspaceId: TEST_WORKSPACE_ID,
    kind: 'mcp-project',
    actsForPrincipalId: ownerId,
    clientSecretHash: null,
    redirectUris: [REDIRECT],
    oidcAudience: null,
    agentIds: ['agent-1'],
    resourcePath: '/mcp/projects/docs',
    ...over,
  };
}

beforeEach(async () => {
  vi.stubEnv('AW_PUBLIC_URL', ORIGIN);
  resetOAuthLimits();
  harness = installRbacHarness([
    { email: ownerCaller.email, name: 'Owner', workspaceId: TEST_WORKSPACE_ID, role: 'owner' },
    { email: viewerCaller.email, name: 'Viewer', workspaceId: TEST_WORKSPACE_ID, role: 'viewer' },
  ]);
  const members = await harness.directory.forWorkspace(TEST_WORKSPACE_ID).listMemberships();
  const principalOf = (email: string): string =>
    members.find((m) => m.email === email)?.principalId ?? 'missing';
  ownerId = principalOf(ownerCaller.email);
  viewerId = principalOf(viewerCaller.email);

  const minted = await mintClientSecret();
  secret = minted.presented;
  mcp = client({
    id: crypto.randomUUID(),
    name: 'Docs <b>bot</b>',
    clientSecretHash: minted.secretHash,
  });
  a2a = client({
    id: crypto.randomUUID(),
    name: 'Helper',
    kind: 'a2a-agent',
    resourcePath: '/api/a2a/agents/helper',
  });
  builder = client({
    id: crypto.randomUUID(),
    name: 'Claude Code',
    kind: 'builder',
    agentIds: [],
    resourcePath: BUILDER_RESOURCE_PATH,
  });
  builderConfidential = {
    ...builder,
    id: crypto.randomUUID(),
    clientSecretHash: minted.secretHash,
  };
  foreign = client({
    id: crypto.randomUUID(),
    name: 'Foreign',
    workspaceId: OTHER_WORKSPACE,
    clientSecretHash: minted.secretHash,
  });
  clients = new Map([mcp, a2a, builder, builderConfidential, foreign].map((c) => [c.id, c]));
  rows = [];
  audits = [];
  cannotRun = new Set();
  agentGone = false;
  bodies = [];
  const repo = fakeTokens(rows);
  installTestDomains({
    oauth: {
      findClient: (id) => Promise.resolve(clients.get(id) ?? null),
      canRunAll: (principal: Principal) => Promise.resolve(!cannotRun.has(principal.principalId)),
      agentNames: (_workspaceId, agentIds) =>
        Promise.resolve(agentGone ? null : agentIds.map((id) => `<i>${id}</i>`)),
      tokens: () => Promise.resolve(repo),
      audit: (workspaceId, actor, event) => {
        audits.push({ workspaceId, actor, event });
        return Promise.resolve();
      },
      findMember: () => Promise.resolve(null),
      issueExchanged: () => Promise.reject(new Error('the exchange is not under test here')),
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearApplicationContext();
  clearClientIdentity();
  harness.teardown();
});

export async function send(
  request: Request,
  handler: (r: Request) => Response | Promise<Response>,
) {
  const response = await handler(request);
  const text = await response.text();
  bodies.push(text);
  return { response, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

export const urlencoded = (params: Record<string, string>): string =>
  new URLSearchParams(params).toString();

export function tokenRequest(
  params: Record<string, string>,
  headers: Record<string, string> = {},
  path = '/oauth/token',
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: urlencoded(params),
  });
}

export const basic = (id: string, pass: string): Record<string, string> => ({
  authorization: `Basic ${btoa(`${id}:${pass}`)}`,
});

export const authorizeParams = (over: Record<string, string> = {}): Record<string, string> => ({
  response_type: 'code',
  client_id: a2a.id,
  redirect_uri: REDIRECT,
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
  state: 'xyz',
  ...over,
});

export const authorizeGet = (
  params: Record<string, string>,
  caller: typeof ownerCaller | null = ownerCaller,
) =>
  send(
    new Request(`${ORIGIN}/oauth/authorize?${urlencoded(params)}`, {
      headers: callerHeaders(caller),
    }),
    AUTHORIZE_GET,
  );

export function authorizePost(
  params: Record<string, string>,
  headers: Record<string, string> = { origin: ORIGIN, ...callerHeaders(ownerCaller) },
) {
  return send(
    new Request(`${ORIGIN}/oauth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: urlencoded(params),
    }),
    AUTHORIZE_POST,
  );
}

export async function approvedCode(over: Record<string, string> = {}): Promise<string> {
  const { response } = await authorizePost({ ...authorizeParams(over), decision: 'approve' });
  expect(response.status).toBe(303);
  const code = new URL(response.headers.get('location') ?? '').searchParams.get('code');
  if (code === null) throw new Error('no code');
  return code;
}

export const codeGrant = (
  code: string,
  over: Record<string, string> = {},
): Record<string, string> => ({
  grant_type: 'authorization_code',
  client_id: a2a.id,
  code,
  redirect_uri: REDIRECT,
  code_verifier: VERIFIER,
  ...over,
});

export async function issueTokens(): Promise<{ access: string; refresh: string }> {
  const out = await send(tokenRequest(codeGrant(await approvedCode())), TOKEN);
  expect(out.response.status).toBe(200);
  const body = out.json();
  return { access: String(body['access_token']), refresh: String(body['refresh_token']) };
}
export const fixture = {
  get harness() {
    return harness;
  },
  set harness(value: typeof harness) {
    harness = value;
  },
  get ownerId() {
    return ownerId;
  },
  set ownerId(value: typeof ownerId) {
    ownerId = value;
  },
  get viewerId() {
    return viewerId;
  },
  set viewerId(value: typeof viewerId) {
    viewerId = value;
  },
  get rows() {
    return rows;
  },
  set rows(value: typeof rows) {
    rows = value;
  },
  get audits() {
    return audits;
  },
  set audits(value: typeof audits) {
    audits = value;
  },
  get clients() {
    return clients;
  },
  set clients(value: typeof clients) {
    clients = value;
  },
  get cannotRun() {
    return cannotRun;
  },
  set cannotRun(value: typeof cannotRun) {
    cannotRun = value;
  },
  get agentGone() {
    return agentGone;
  },
  set agentGone(value: typeof agentGone) {
    agentGone = value;
  },
  get secret() {
    return secret;
  },
  set secret(value: typeof secret) {
    secret = value;
  },
  get mcp() {
    return mcp;
  },
  set mcp(value: typeof mcp) {
    mcp = value;
  },
  get a2a() {
    return a2a;
  },
  set a2a(value: typeof a2a) {
    a2a = value;
  },
  get builder() {
    return builder;
  },
  set builder(value: typeof builder) {
    builder = value;
  },
  get builderConfidential() {
    return builderConfidential;
  },
  set builderConfidential(value: typeof builderConfidential) {
    builderConfidential = value;
  },
  get foreign() {
    return foreign;
  },
  set foreign(value: typeof foreign) {
    foreign = value;
  },
  get bodies() {
    return bodies;
  },
  set bodies(value: typeof bodies) {
    bodies = value;
  },
};
