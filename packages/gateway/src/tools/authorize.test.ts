import type {
  DatabaseRoot,
  RunRecord,
  ToolConnectorRecord,
  WorkspaceScope,
} from '@agent-workspace/core/db';
import type { SecretsService } from '@agent-workspace/core/secrets';
import { canonicalCall } from '@indx-workspace/contracts/agents';
import { verifyIdentity } from '@indx-workspace/contracts/identity-assertion';
import { describe, expect, it } from 'vitest';

import type { RunTokenClaims } from '../tokens/run-token.js';
import {
  authorizeToolCall,
  createDatabaseToolResolver,
  approvalDecision,
  AW_CONTROL_APPROVAL_RULES,
  awControlApprovalDecision,
  type ToolApproval,
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
const WRITE_TOOL_CONFIG = {
  openapi: {
    ...TOOL_CONFIG.openapi,
    allow: ['GET /**', 'POST /pets'],
    operations: [
      ...TOOL_CONFIG.openapi.operations,
      { name: 'addPet', method: 'POST', path: '/pets' },
    ],
  },
  parameters: { ...TOOL_CONFIG.parameters, addPet: [] },
};

function fakeDatabase(
  options: {
    active?: boolean;
    toolConfig?: unknown;
    kind?: ToolConnectorRecord['kind'];
    identitySecretName?: string;
    approvedToolCalls?: { toolName: string; canonicalCall: string }[];
    consumeOutcome?: 'consumed' | 'already-used' | 'not-approved';
    others?: { id: string; name: string }[];
  } = {},
) {
  const calls: string[] = [];
  const connector: ToolConnectorRecord = {
    id: RUN_A_CONNECTOR,
    workspaceId: WORKSPACE,
    name: 'pets',
    kind: options.kind ?? 'openapi',
    toolConfig: (options.toolConfig ?? TOOL_CONFIG) as Record<string, unknown>,
    credentialSecretId: 'secret-id',
    identitySecretName: options.identitySecretName ?? null,
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
        consumeApprovedCall: (runId: string, call: { canonicalCall: string }) => {
          calls.push(`runs.consumeApprovedCall:${runId}:${call.canonicalCall}`);
          return Promise.resolve(options.consumeOutcome ?? 'consumed');
        },
        get: () => {
          calls.push('runs.get');
          return Promise.resolve({
            id: CLAIMS.runId,
            status: 'running',
            toolConnectorIds: [RUN_A_CONNECTOR, ...(options.others ?? []).map((o) => o.id)],
            approvedToolCalls: options.approvedToolCalls,
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
        listToolConnectors: () => {
          calls.push('mcpServers.listToolConnectors');
          return Promise.resolve([
            ...(options.others ?? []).map((other) => ({ ...connector, ...other })),
            connector,
          ]);
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
    list: () => {
      calls.push('secrets.list');
      return Promise.resolve([{ id: 'secret-id', name: 'TOOL_PETS' }]);
    },
    resolveByName: (_scope: WorkspaceScope, name: string) => {
      calls.push(`secrets.resolveByName:${name}`);
      return Promise.resolve(
        name === 'IDENTITY_KEY' ? { value: Buffer.from('k'.repeat(32)) } : null,
      );
    },
    resolveById: (_scope: WorkspaceScope, id: string) => {
      calls.push(`secrets.resolveById:${id}`);
      return Promise.resolve({ value: Buffer.from('fixture-tool-credential') });
    },
  } as unknown as SecretsService;
  return { database, secrets, calls };
}

describe('approvalDecision (#1304, #1541)', () => {
  const operations = [
    { name: 'getPet', method: 'GET', path: '/pets/{id}' },
    { name: 'addPet', method: 'POST', path: '/pets' },
  ] as const;
  const call = (args: unknown) => canonicalCall('mcp__pets__addPet', args);
  const approval = (...approvedToolCalls: string[]): ToolApproval => ({
    serverKey: 'pets',
    approvedToolCalls,
    consume: () => Promise.resolve('consumed'),
  });
  const write = (args: unknown) => ({
    kind: 'write',
    call: { toolName: 'mcp__pets__addPet', canonicalCall: call(args) },
  });

  it('lets a read run without any approval, and names nothing to consume', () => {
    expect(approvalDecision(approval(), operations, 'getPet', { id: '1' })).toEqual({
      kind: 'read',
    });
  });

  it('lets a write run only for the exact approved arguments, naming the call to consume', () => {
    const approved = approval(call({ body: { n: 1 } }));
    expect(approvalDecision(approved, operations, 'addPet', { body: { n: 1 } })).toEqual(
      write({ body: { n: 1 } }),
    );
    expect(approvalDecision(approved, operations, 'addPet', { body: { n: 2 } })).toEqual({
      kind: 'refused',
    });
    expect(approvalDecision(approval(), operations, 'addPet', { body: { n: 1 } })).toEqual({
      kind: 'refused',
    });
  });

  it('is indifferent to key order, as the engine canonical call is', () => {
    const approved = approval(call({ a: 1, b: 2 }));
    expect(approvalDecision(approved, operations, 'addPet', { b: 2, a: 1 })).toEqual(
      write({ a: 1, b: 2 }),
    );
  });

  it('treats a missing argument object as {}', () => {
    expect(approvalDecision(approval(call({})), operations, 'addPet', undefined)).toEqual(
      write({}),
    );
  });

  it('never approves arguments that are not JSON', () => {
    expect(approvalDecision(approval(call({})), operations, 'addPet', { n: 1n })).toEqual({
      kind: 'refused',
    });
  });
});

describe('the aw-control backstop (#1846)', () => {
  it('gates exactly the Builder tools that write or spend', () => {
    expect(AW_CONTROL_APPROVAL_RULES).toEqual([
      'mcp__aw-control__draft_save',
      'mcp__aw-control__evals_run',
      'mcp__aw-control__trial_run',
    ]);
  });

  it('lets a read run, and a write only for its approved canonical call', () => {
    const call = canonicalCall('mcp__aw-control__trial_run', { n: 1 });
    const approval: ToolApproval = {
      serverKey: 'aw-control',
      approvedToolCalls: [call],
      consume: () => Promise.resolve('consumed'),
    };
    expect(awControlApprovalDecision(approval, 'catalog_list', {})).toEqual({ kind: 'read' });
    expect(awControlApprovalDecision(approval, 'trial_run', { n: 1 })).toEqual({
      kind: 'write',
      call: { toolName: 'mcp__aw-control__trial_run', canonicalCall: call },
    });
    expect(awControlApprovalDecision(approval, 'evals_run', { n: 1 })).toEqual({
      kind: 'refused',
    });
  });
});

describe('createDatabaseToolResolver', () => {
  it('authorises through the scoped repositories and decrypts only the connector secret', async () => {
    const fake = fakeDatabase({ toolConfig: WRITE_TOOL_CONFIG });
    const resolved = await createDatabaseToolResolver(fake.database, fake.secrets).resolve(
      CLAIMS,
      'hash',
      RUN_A_CONNECTOR,
    );
    if (!resolved.ok) throw new Error('expected an authorised connector');
    expect(await resolved.connector.credential()).toBe('fixture-tool-credential');
    expect(fake.calls).toEqual([
      'runTokens.isActive',
      'runs.get',
      'mcpServers.getToolConnector',
      'mcpServers.listToolConnectors',
      'secrets.resolveById:secret-id',
    ]);
    expect(resolved.connector).toMatchObject({
      kind: 'openapi',
      config: {
        operations: [{ name: 'listPets', method: 'GET', path: '/pets' }, { name: 'addPet' }],
      },
    });
  });

  it('resolves a read-only connector without listing the run connectors or approval data', async () => {
    const fake = fakeDatabase();
    const resolved = await createDatabaseToolResolver(fake.database, fake.secrets).resolve(
      CLAIMS,
      'hash',
      RUN_A_CONNECTOR,
    );
    if (!resolved.ok || resolved.connector.kind === 'postgres') throw new Error('expected openapi');
    expect(resolved.connector.approval).toBeUndefined();
    expect(fake.calls).toEqual(['runTokens.isActive', 'runs.get', 'mcpServers.getToolConnector']);
  });

  it('resolver reads the credential with one secrets call', async () => {
    const fake = fakeDatabase();
    const resolved = await createDatabaseToolResolver(fake.database, fake.secrets).resolve(
      CLAIMS,
      'hash',
      RUN_A_CONNECTOR,
    );
    if (!resolved.ok) throw new Error('expected an authorised connector');
    await resolved.connector.credential();
    expect(fake.calls).toContain('secrets.resolveById:secret-id');
    expect(fake.calls.filter((call) => call.startsWith('secrets.'))).toEqual([
      'secrets.resolveById:secret-id',
    ]);
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

  describe('the approval data (#1304)', () => {
    const approvalOf = async (options: Parameters<typeof fakeDatabase>[0]) => {
      const fake = fakeDatabase({ toolConfig: WRITE_TOOL_CONFIG, ...options });
      const resolved = await createDatabaseToolResolver(fake.database, fake.secrets).resolve(
        CLAIMS,
        'hash',
        RUN_A_CONNECTOR,
      );
      if (!resolved.ok || resolved.connector.kind === 'postgres')
        throw new Error('expected openapi');
      return { approval: resolved.connector.approval, calls: fake.calls };
    };

    it('keys the connector by its name and carries the run approved canonical calls', async () => {
      const canonical = canonicalCall('mcp__pets__addPet', { body: { n: 1 } });
      const { approval } = await approvalOf({
        approvedToolCalls: [{ toolName: 'mcp__pets__addPet', canonicalCall: canonical }],
      });
      expect(approval).toMatchObject({ serverKey: 'pets', approvedToolCalls: [canonical] });
      expect((await approvalOf({})).approval).toMatchObject({
        serverKey: 'pets',
        approvedToolCalls: [],
      });
    });

    it('suffixes the key as compose does when another connector of the run sorts first', async () => {
      // 55555555-… sorts before RUN_A_CONNECTOR (66666666-…) and takes the name `pets` first.
      const { approval } = await approvalOf({
        others: [{ id: '55555555-5555-4555-8555-555555555555', name: 'pets' }],
      });
      expect(approval?.serverKey).toBe('pets_2');
    });

    it('consumes through the run repository and passes its outcome on', async () => {
      const call = { toolName: 'mcp__pets__addPet', canonicalCall: '{}' };
      for (const consumeOutcome of ['consumed', 'already-used', 'not-approved'] as const) {
        const resolved = await approvalOf({ consumeOutcome });
        await expect(resolved.approval?.consume(call)).resolves.toBe(consumeOutcome);
        expect(resolved.calls).toContain(`runs.consumeApprovedCall:${CLAIMS.runId}:{}`);
      }
    });
  });

  describe('the identity assertion (ADR-0142)', () => {
    const CALLER = { sub: 'customer-42', principalKind: 'api-key' } as const;
    const resolve = async (claims: RunTokenClaims, identitySecretName?: string) => {
      const fake = fakeDatabase(identitySecretName === undefined ? {} : { identitySecretName });
      const resolved = await createDatabaseToolResolver(
        fake.database,
        fake.secrets,
        () => 1_000,
      ).resolve(claims, 'hash', RUN_A_CONNECTOR);
      if (!resolved.ok) throw new Error('expected an authorised connector');
      return { connector: resolved.connector, calls: fake.calls };
    };

    it('offers no signer to a connector that did not opt in, and reads no identity secret', async () => {
      const { connector, calls } = await resolve({ ...CLAIMS, caller: CALLER });
      expect(connector.identity).toBeUndefined();
      expect(calls.some((call) => call.startsWith('secrets.resolveByName'))).toBe(false);
    });

    it('signs a fresh assertion for the caller, audience the connector, per call', async () => {
      const { connector } = await resolve({ ...CLAIMS, caller: CALLER }, 'IDENTITY_KEY');
      const header = await connector.identity?.();
      expect(header).toEqual(expect.any(String));
      await expect(
        verifyIdentity(header ?? '', 'k'.repeat(32), new Date(1_000_000), {
          audience: RUN_A_CONNECTOR,
          workspace: WORKSPACE,
        }),
      ).resolves.toMatchObject({
        ok: true,
        payload: { ...CALLER, runId: CLAIMS.runId, aud: RUN_A_CONNECTOR, exp: 1_300 },
      });
    });

    it('cannot sign without a caller or without the secret', async () => {
      const noCaller = await resolve(CLAIMS, 'IDENTITY_KEY');
      await expect(noCaller.connector.identity?.()).resolves.toBeNull();
      const noSecret = await resolve({ ...CLAIMS, caller: CALLER }, 'MISSING_KEY');
      await expect(noSecret.connector.identity?.()).resolves.toBeNull();
    });
  });
});
