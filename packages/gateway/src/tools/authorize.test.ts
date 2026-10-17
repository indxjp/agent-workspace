import type {
  DatabaseRoot,
  RunRecord,
  ToolConnectorRecord,
  WorkspaceScope,
} from '@agent-workspace/core/db';
import type { SecretsService } from '@agent-workspace/core/secrets';
import { describe, expect, it } from 'vitest';

import type { RunTokenClaims } from '../tokens/run-token.js';
import {
  authorizeToolCall,
  createDatabaseToolResolver,
  type ToolAuthorizationFacts,
} from './authorize.js';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const RUN_A_CONNECTOR = '66666666-6666-4666-8666-666666666666';
const RUN_B_CONNECTOR = '77777777-7777-4777-8777-777777777777';

const LIVE: ToolAuthorizationFacts = {
  tokenActive: true,
  run: { status: 'running', toolConnectorIds: [RUN_A_CONNECTOR] },
  connector: { workspaceId: WORKSPACE, kind: 'openapi', enabled: true },
  workspaceId: WORKSPACE,
  connectorId: RUN_A_CONNECTOR,
};

describe('authorizeToolCall (C16)', () => {
  it('allows a live run on one of its own enabled openapi connectors', () => {
    expect(authorizeToolCall(LIVE)).toEqual({ ok: true });
  });

  it.each<[string, Partial<ToolAuthorizationFacts>]>([
    ['an ended run (registry row revoked)', { tokenActive: false }],
    [
      'a terminal run with a live registry row',
      { run: { status: 'completed', toolConnectorIds: [RUN_A_CONNECTOR] } },
    ],
    ['a missing run', { run: null }],
  ])('refuses %s with 401 tool_run_not_active', (_name, facts) => {
    expect(authorizeToolCall({ ...LIVE, ...facts })).toEqual({
      ok: false,
      status: 401,
      code: 'tool_run_not_active',
    });
  });

  it.each<[string, Partial<ToolAuthorizationFacts>]>([
    ["run A's token on run B's connector", { connectorId: RUN_B_CONNECTOR }],
    ['a run with no tool connectors', { run: { status: 'running', toolConnectorIds: [] } }],
    ['a connector from no workspace of the token', { connector: null }],
    [
      'a connector in another workspace',
      { connector: { workspaceId: 'other', kind: 'openapi', enabled: true } },
    ],
    [
      'a disabled connector',
      { connector: { workspaceId: WORKSPACE, kind: 'openapi', enabled: false } },
    ],
    [
      'a postgres connector',
      { connector: { workspaceId: WORKSPACE, kind: 'postgres', enabled: true } },
    ],
  ])('refuses %s with 403 tool_not_in_run', (_name, facts) => {
    expect(authorizeToolCall({ ...LIVE, ...facts })).toEqual({
      ok: false,
      status: 403,
      code: 'tool_not_in_run',
    });
  });
});

const CLAIMS: RunTokenClaims = {
  version: 1,
  tokenId: 'token',
  runId: '11111111-1111-4111-8111-111111111111',
  sessionId: '55555555-5555-4555-8555-555555555555',
  workspaceId: WORKSPACE,
  agentId: '33333333-3333-4333-8333-333333333333',
  modelConnectionId: '44444444-4444-4444-8444-444444444444',
  issuedAt: 1,
  expiresAt: 2,
};

const TOOL_CONFIG = {
  openapi: {
    spec: { digest: `sha256:${'a'.repeat(64)}`, bytes: 1 },
    baseUrl: 'https://api.example.test',
    auth: 'bearer',
    allow: ['GET /**'],
    operations: [{ name: 'listPets', method: 'GET', path: '/pets' }],
  },
  parameters: { listPets: [{ name: 'limit', in: 'query', required: false }] },
};

function fakeDatabase(
  options: { active?: boolean; toolConfig?: unknown; kind?: ToolConnectorRecord['kind'] } = {},
) {
  const calls: string[] = [];
  const connector: ToolConnectorRecord = {
    id: RUN_A_CONNECTOR,
    workspaceId: WORKSPACE,
    name: 'pets',
    kind: options.kind ?? 'openapi',
    toolConfig: (options.toolConfig ?? TOOL_CONFIG) as Record<string, unknown>,
    credentialSecretId: 'secret-id',
    enabled: true,
    createdBy: null,
    ownerPrincipalId: 'owner',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const database = {
    scopes: { forWorkspaceId: () => Promise.resolve('scope' as unknown as WorkspaceScope) },
    runTokens: {
      forScope: () => ({
        isActive: () => {
          calls.push('runTokens.isActive');
          return Promise.resolve(options.active ?? true);
        },
      }),
    },
    runs: {
      forScope: () => ({
        get: () => {
          calls.push('runs.get');
          return Promise.resolve({
            status: 'running',
            toolConnectorIds: [RUN_A_CONNECTOR],
          } as unknown as RunRecord);
        },
      }),
    },
    mcpServers: {
      forScope: () => ({
        getToolConnector: () => {
          calls.push('mcpServers.getToolConnector');
          return Promise.resolve(connector);
        },
      }),
    },
    modelConnections: {
      forScope: () => {
        calls.push('modelConnections');
        throw new Error('the tool route must not read a model connection');
      },
    },
  } as unknown as DatabaseRoot;
  const secrets = {
    list: () => Promise.resolve([{ id: 'secret-id', name: 'TOOL_PETS' }]),
    resolveByName: (_scope: WorkspaceScope, name: string) => {
      calls.push(`secrets.resolveByName:${name}`);
      return Promise.resolve({ value: Buffer.from('fixture-tool-credential') });
    },
  } as unknown as SecretsService;
  return { database, secrets, calls };
}

describe('createDatabaseToolResolver', () => {
  it('authorises through the scoped repositories and decrypts only the connector secret', async () => {
    const fake = fakeDatabase();
    const resolved = await createDatabaseToolResolver(fake.database, fake.secrets).resolve(
      CLAIMS,
      'hash',
      RUN_A_CONNECTOR,
    );
    if (!resolved.ok) throw new Error('expected an authorised connector');
    expect(fake.calls).not.toContain('secrets.resolveByName:TOOL_PETS');
    expect(await resolved.connector.credential()).toBe('fixture-tool-credential');
    expect(fake.calls).toEqual([
      'runTokens.isActive',
      'runs.get',
      'mcpServers.getToolConnector',
      'secrets.resolveByName:TOOL_PETS',
    ]);
    expect(resolved.connector).toMatchObject({
      kind: 'openapi',
      config: { operations: [{ name: 'listPets', method: 'GET', path: '/pets' }] },
    });
  });

  it('refuses a postgres connector before reading its tool_config or its credential', async () => {
    const fake = fakeDatabase({ kind: 'postgres', toolConfig: { postgres: {} } });
    await expect(
      createDatabaseToolResolver(fake.database, fake.secrets).resolve(
        CLAIMS,
        'hash',
        RUN_A_CONNECTOR,
      ),
    ).resolves.toEqual({ ok: false, status: 403, code: 'tool_not_in_run' });
    expect(fake.calls).toEqual(['runTokens.isActive', 'runs.get', 'mcpServers.getToolConnector']);
  });

  it('stops at the token registry for an ended run and reads no connector', async () => {
    const fake = fakeDatabase({ active: false });
    await expect(
      createDatabaseToolResolver(fake.database, fake.secrets).resolve(
        CLAIMS,
        'hash',
        RUN_A_CONNECTOR,
      ),
    ).resolves.toEqual({ ok: false, status: 401, code: 'tool_run_not_active' });
    expect(fake.calls).toEqual(['runTokens.isActive']);
  });

  it('treats a tool_config that is not the persisted shape as a defect', async () => {
    const fake = fakeDatabase({ toolConfig: { openapi: TOOL_CONFIG.openapi } });
    await expect(
      createDatabaseToolResolver(fake.database, fake.secrets).resolve(
        CLAIMS,
        'hash',
        RUN_A_CONNECTOR,
      ),
    ).rejects.toThrow();
  });
});
