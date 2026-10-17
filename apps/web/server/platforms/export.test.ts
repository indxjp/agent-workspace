import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { EndpointClientResource } from '@indx-workspace/contracts/endpoint-clients';
import {
  PLATFORM_EXPORT_MAX_BYTES,
  PlatformExportResponseSchema,
} from '@indx-workspace/contracts/platforms';

import { createInMemoryAgentVersionStoreProvider } from '../agent-versions/memory-store';
import { versionRequest } from '../agent-versions/fixtures';
import { createAgentVersion } from '../agent-versions/handlers';
import { FIXTURE_PERMISSIONS } from '../agent-versions/fixtures';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { createConnector } from '../connectors/handlers';
import { createInMemoryConnectorsStoreProvider } from '../connectors/memory-store';
import type { WorkspaceAgentVersionStore } from '../agent-versions/store';
import type { ApiResult } from '../agents/handlers';
import { exportAgentVersion, exportFileBytes } from './export';
import {
  buildPortableProject,
  PlatformExportTooLargeError,
  toolEndpointOf,
  type PortableProjectSources,
} from './project';

const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const PRINCIPAL = '36377a6a-7a0b-4610-8efc-d31547dcc38a';
const SECRET_SENTINEL = 'sk-sentinel-DO-NOT-LEAK-0123456789';
const PETSTORE = readFileSync(
  new URL('../openapi/fixtures/petstore-3.0.yaml', import.meta.url),
  'utf8',
);
const PETSTORE_JSON = readFileSync(
  new URL('../openapi/fixtures/petstore-3.0.json', import.meta.url),
  'utf8',
);

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

interface SkillFileBytes {
  readonly path: string;
  readonly bytes: Uint8Array;
}

interface World {
  readonly agentId: string;
  readonly reads: string[];
  readonly sources: PortableProjectSources;
  readonly otherWorkspace: PortableProjectSources;
  readonly store: WorkspaceAgentVersionStore;
  readonly provider: ReturnType<typeof createInMemoryAgentVersionStoreProvider>;
  readonly agents: ReturnType<typeof createInMemoryAgentStoreProvider>;
}

async function world(
  options: {
    readonly name?: string;
    readonly model?: string | null;
    readonly connectors?: readonly string[];
    readonly skills?: readonly string[];
    readonly skillFiles?: Readonly<Record<string, readonly SkillFileBytes[]>>;
    readonly workspaceFiles?: Readonly<Record<string, Uint8Array>>;
    readonly endpointClients?: readonly EndpointClientResource[];
    readonly publicOrigin?: string | null;
    readonly seed?: (
      connectors: ReturnType<typeof createInMemoryConnectorsStoreProvider>,
    ) => Promise<void>;
  } = {},
): Promise<World> {
  const agents = createInMemoryAgentStoreProvider();
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name: options.name ?? 'support-triage',
      instructions: '',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
    },
    { principalId: PRINCIPAL, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the fixture agent');
  const agent = await agents.forWorkspace(WORKSPACE).get(created.agent.id);
  if (agent === null) throw new Error('the fixture agent exists');

  const connectors = createInMemoryConnectorsStoreProvider();
  await options.seed?.(connectors);

  const provider = createInMemoryAgentVersionStoreProvider({
    agents,
    references: {
      [WORKSPACE]: {
        connector: (options.connectors ?? []).map((name) => ({ id: crypto.randomUUID(), name })),
        skill: (options.skills ?? []).map((name) => ({ id: crypto.randomUUID(), name })),
      },
    },
  });
  const store = await provider.forWorkspace(WORKSPACE);
  if (store === null) throw new Error('the memory store answers every workspace');
  const request = versionRequest({
    name: options.name ?? 'support-triage',
    resources: { connectors: [...(options.connectors ?? [])], skills: [...(options.skills ?? [])] },
  });
  const saved = await createAgentVersion(
    {
      ...request,
      body: {
        ...request.body,
        definition: {
          ...request.body.definition,
          agent: {
            ...request.body.definition.agent,
            model: options.model === undefined ? 'claude-sonnet-4-5' : options.model,
          },
        },
      },
    },
    agent,
    PRINCIPAL,
    { store },
  );
  if (saved.status !== 201)
    throw new Error(`the fixture version was refused: ${JSON.stringify(saved.body)}`);

  const reads: string[] = [];
  const skillFiles: PortableProjectSources['skillFiles'] = (name) =>
    Promise.resolve(
      (options.skillFiles?.[name] ?? []).map((file) => ({
        path: file.path,
        sizeBytes: file.bytes.byteLength,
        read: () => {
          reads.push(`${name}/${file.path}`);
          return Promise.resolve(file.bytes);
        },
      })),
    );
  const other = await provider.forWorkspace('77777777-7777-4777-8777-777777777777');
  if (other === null) throw new Error('the memory store answers every workspace');
  const common = {
    skillFiles,
    workspaceFile: (path: string): Promise<Uint8Array | null> => {
      reads.push(path);
      return Promise.resolve(options.workspaceFiles?.[path] ?? null);
    },
    endpointClients: (): Promise<readonly EndpointClientResource[]> =>
      Promise.resolve(options.endpointClients ?? []),
    publicOrigin:
      options.publicOrigin === undefined ? 'https://aw.example.com' : options.publicOrigin,
  };
  return {
    agentId: agent.id,
    reads,
    sources: { ...common, versions: store, connectors: connectors.forWorkspace(WORKSPACE) },
    otherWorkspace: {
      ...common,
      versions: other,
      connectors: connectors.forWorkspace('77777777-7777-4777-8777-777777777777'),
    },
    store,
    provider,
    agents,
  };
}

/** Seed an agent named `name` whose version 1 holds `body` and is pointed at by `environment`. */
async function seedAgentVersion(
  seeded: Pick<World, 'store' | 'provider' | 'agents'>,
  name: string,
  environment: 'production' | 'local' | null,
  edits: {
    readonly subagents?: readonly string[];
    readonly bodyName?: string;
    readonly connectors?: readonly string[];
  } = {},
): Promise<string> {
  const created = await seeded.agents.forWorkspace(WORKSPACE).create(
    {
      name,
      instructions: '',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
    },
    { principalId: PRINCIPAL, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the agent');
  const base = versionRequest({
    name: edits.bodyName ?? name,
    resources: { connectors: [...(edits.connectors ?? [])] },
  }).body;
  const body = {
    ...base,
    definition: {
      ...base.definition,
      agent: { ...base.definition.agent, model: 'claude-sonnet-4-5' },
    },
    ...(edits.subagents === undefined
      ? {}
      : { subagents: edits.subagents.map((each) => ({ name: each })) }),
  };
  const version = await seeded.store.create(created.agent.id, {
    summary: 'seed',
    via: 'api',
    body,
    createdByPrincipalId: PRINCIPAL,
  });
  if (version.kind !== 'created') throw new Error('the memory store creates the version');
  if (environment !== null) {
    seeded.provider.point({
      workspaceId: WORKSPACE,
      agentId: created.agent.id,
      environment,
      versionId: version.version.id,
      number: version.version.number,
      updatedAt: new Date(),
    });
  }
  return created.agent.id;
}

async function seedConnector(
  connectors: ReturnType<typeof createInMemoryConnectorsStoreProvider>,
  name: string,
  overrides: {
    readonly url?: string;
    readonly authType?: 'none' | 'bearer' | 'api-key';
    readonly credential?: string | null;
  } = {},
): Promise<void> {
  const authType = overrides.authType ?? 'none';
  const created = await connectors.forWorkspace(WORKSPACE).create(
    {
      name,
      transport: 'http',
      command: null,
      args: null,
      url: overrides.url ?? `https://${name}.example.com/mcp`,
      authType,
      credential:
        authType === 'none'
          ? null
          : overrides.credential === undefined
            ? SECRET_SENTINEL
            : overrides.credential,
    },
    { principalId: PRINCIPAL, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the connector');
}

function problemOf(result: ApiResult): { code: string; details?: string[] } {
  const error = (result.body as { error: { code: string; details?: string[] } }).error;
  return error;
}

describe('exportAgentVersion', () => {
  it('compiles one stored version and appends the report file, sorted by path', async () => {
    const { agentId, sources } = await world();

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    if (!outcome.ok) throw new Error(JSON.stringify(outcome.result.body));
    PlatformExportResponseSchema.parse(outcome.response);
    expect(outcome.agentName).toBe('support-triage');
    expect(outcome.response).toMatchObject({
      agentId,
      version: 1,
      platform: 'claude-managed-agents',
    });
    const paths = outcome.response.files.map((file) => file.path);
    expect(paths).toContain('PLATFORM_REPORT.md');
    expect(paths).toStrictEqual([...paths].sort());
    expect(outcome.response.report.length).toBeGreaterThan(0);
  });

  it.each([
    ['a body that is not an object', 'nope'],
    ['an unknown platform', { version: 1, platform: 'nowhere' }],
    ['a version of zero', { version: 0, platform: 'copilot-studio' }],
    ['an extra key', { version: 1, platform: 'copilot-studio', extra: true }],
  ])('refuses %s with invalid_platform_export', async (_name, body) => {
    const { agentId, sources } = await world();

    const outcome = await exportAgentVersion(agentId, body, sources);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.result.status).toBe(400);
    expect(problemOf(outcome.result).code).toBe('invalid_platform_export');
  });

  it('answers 404 with [version:9] for a version that was never saved', async () => {
    const { agentId, sources } = await world();

    const outcome = await exportAgentVersion(
      agentId,
      { version: 9, platform: 'copilot-studio' },
      sources,
    );

    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.result.status).toBe(404);
    expect(problemOf(outcome.result)).toMatchObject({
      code: 'agent_version_not_found',
      details: ['version:9'],
    });
  });

  it("does not find another workspace's version", async () => {
    const { agentId, otherWorkspace } = await world();

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'copilot-studio' },
      otherWorkspace,
    );

    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.result.status).toBe(404);
  });

  it('refuses a name a portable agent cannot carry with agent_name_not_portable', async () => {
    const { agentId, sources } = await world({ name: 'Support triage' });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'copilot-studio' },
      sources,
    );

    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.result.status).toBe(422);
    expect(problemOf(outcome.result).code).toBe('agent_name_not_portable');
  });

  it('answers a compile refusal with its code and status', async () => {
    const { agentId, sources } = await world({ model: null });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.result.status).toBe(422);
    expect(problemOf(outcome.result).code).toBe('platform_model_unsupported');
  });

  it('answers a target option error as platform_options_invalid with path: message details', async () => {
    const { agentId, sources } = await world();

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'copilot-studio', options: { definitelyNotAnOption: 1 } },
      sources,
    );

    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.result.status).toBe(400);
    const problem = problemOf(outcome.result);
    expect(problem.code).toBe('platform_options_invalid');
    expect(problem.details?.length).toBeGreaterThan(0);
  });

  it('round-trips a non-UTF-8 skill file as base64 and keeps text as utf8', async () => {
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    const { agentId, sources } = await world({
      skills: ['triage-guide'],
      skillFiles: {
        'triage-guide': [
          {
            path: 'SKILL.md',
            bytes: encode('---\nname: triage-guide\ndescription: Triage.\n---\nBody\n'),
          },
          { path: 'assets/blob.bin', bytes: binary },
        ],
      },
    });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    if (!outcome.ok) throw new Error(JSON.stringify(outcome.result.body));
    const blob = outcome.response.files.find((file) => file.path.endsWith('blob.bin'));
    expect(blob?.encoding).toBe('base64');
    if (blob === undefined) throw new Error('the skill asset is exported');
    expect(new Uint8Array(exportFileBytes(blob))).toStrictEqual(binary);
    const skill = outcome.response.files.find((file) => file.path.endsWith('SKILL.md'));
    expect(skill?.encoding).toBe('utf8');
  });

  it('refuses an export over PLATFORM_EXPORT_MAX_BYTES with 422 platform_export_too_large', async () => {
    const { agentId, sources } = await world({
      skills: ['triage-guide'],
      skillFiles: {
        'triage-guide': [
          {
            path: 'SKILL.md',
            bytes: encode('---\nname: triage-guide\ndescription: Triage.\n---\nBody\n'),
          },
          { path: 'assets/huge.bin', bytes: new Uint8Array(PLATFORM_EXPORT_MAX_BYTES + 1) },
        ],
      },
    });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    if (outcome.ok) throw new Error('the over-size export is refused');
    expect(outcome.result.status).toBe(422);
    const error = problemOf(outcome.result);
    expect(error.code).toBe('platform_export_too_large');
    expect(error.details?.[0]).toMatch(/^bytes:\d+$/u);
    expect(error.details?.[1]).toBe('max:8388608');
  });

  it('reports a skill that has no SKILL.md as dropped instead of failing', async () => {
    const { agentId, sources } = await world({ skills: ['gone'], skillFiles: {} });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    if (!outcome.ok) throw new Error(JSON.stringify(outcome.result.body));
    expect(outcome.response.report).toContainEqual(
      expect.objectContaining({
        path: 'agents.support-triage.skills.0',
        verdict: 'dropped',
        code: 'field_unsupported',
      }),
    );
  });

  it('never carries a connector credential; it appears only as a reference by name', async () => {
    const { agentId, sources } = await world({
      connectors: ['crm'],
      seed: async (connectors) => {
        const created = await connectors.forWorkspace(WORKSPACE).create(
          {
            name: 'crm',
            transport: 'http',
            command: null,
            args: null,
            url: 'https://crm.example.com/mcp',
            authType: 'bearer',
            credential: SECRET_SENTINEL,
          },
          { principalId: PRINCIPAL, userId: null },
        );
        if (created.kind !== 'created') throw new Error('the memory store creates the connector');
      },
    });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    if (!outcome.ok) throw new Error(JSON.stringify(outcome.result.body));
    const serialised = JSON.stringify(outcome.response);
    expect(serialised).not.toContain(SECRET_SENTINEL);
    expect(serialised).toContain('CONNECTOR_CRM');
  });

  it.each([
    ['a known query parameter', 'https://crm.example.com/mcp?token=URL-SENTINEL-1234'],
    ['an unknown query parameter', 'https://crm.example.com/mcp?code=URL-SENTINEL-1234'],
    ['a fragment', 'https://crm.example.com/mcp#access_token=URL-SENTINEL-1234'],
    ['the user info', 'https://user:URL-SENTINEL-1234@crm.example.com/mcp'],
    ['an unparseable URL', 'https://crm.example.com:URL-SENTINEL-1234/mcp'],
  ])('drops a connector whose URL is %s, naming it and never the URL', async (_form, url) => {
    const { agentId, sources } = await world({
      connectors: ['crm'],
      seed: (connectors) => seedConnector(connectors, 'crm', { url }),
    });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    if (!outcome.ok) throw new Error(JSON.stringify(outcome.result.body));
    expect(outcome.response.report).toContainEqual({
      path: 'agents.support-triage.definition.resources.connectors.0',
      verdict: 'dropped',
      code: 'field_unsupported',
      note: 'the connector crm: the URL carries a query, fragment or credential; re-register it without one',
    });
    const serialised = JSON.stringify(outcome.response);
    expect(serialised).not.toContain('URL-SENTINEL-1234');
    expect(serialised).not.toContain('crm.example.com');
  });

  it('still exports a connector whose URL is a clean https URL', async () => {
    const { agentId, sources } = await world({
      connectors: ['crm'],
      seed: (connectors) =>
        seedConnector(connectors, 'crm', { url: 'https://crm.example.com/mcp' }),
    });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    if (!outcome.ok) throw new Error(JSON.stringify(outcome.result.body));
    expect(JSON.stringify(outcome.response.files)).toContain('https://crm.example.com/mcp');
    expect(outcome.response.report).not.toContainEqual(
      expect.objectContaining({
        path: 'agents.support-triage.definition.resources.connectors.0',
        verdict: 'dropped',
      }),
    );
  });

  it.each(['bearer', 'api-key'] as const)(
    'drops a %s connector with no credential on file instead of exporting it without auth',
    async (authType) => {
      const { agentId, sources } = await world({
        connectors: ['crm'],
        seed: (connectors) => seedConnector(connectors, 'crm', { authType, credential: null }),
      });

      const outcome = await exportAgentVersion(
        agentId,
        { version: 1, platform: 'claude-managed-agents' },
        sources,
      );

      if (!outcome.ok) throw new Error(JSON.stringify(outcome.result.body));
      expect(outcome.response.report).toContainEqual({
        path: 'agents.support-triage.definition.resources.connectors.0',
        verdict: 'dropped',
        code: 'field_unsupported',
        note: `the connector crm requires a ${authType} credential but none is on file; add one and export again`,
      });
      expect(
        JSON.stringify(outcome.response.files.filter((file) => file.path !== 'PLATFORM_REPORT.md')),
      ).not.toContain('crm.example.com');
    },
  );

  it('drops every connector whose secret name collides and still carries the others', async () => {
    const { agentId, sources } = await world({
      connectors: ['a-b', 'a_b', 'crm'],
      seed: async (connectors) => {
        await seedConnector(connectors, 'a-b', { authType: 'bearer' });
        await seedConnector(connectors, 'a_b', { authType: 'bearer' });
        await seedConnector(connectors, 'crm', { authType: 'bearer' });
      },
    });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    if (!outcome.ok) throw new Error(JSON.stringify(outcome.result.body));
    const note =
      'the connectors a-b, a_b would share the secret name CONNECTOR_A_B; rename one and export again';
    for (const index of [0, 1]) {
      expect(outcome.response.report).toContainEqual({
        path: `agents.support-triage.definition.resources.connectors.${index}`,
        verdict: 'dropped',
        code: 'field_unsupported',
        note,
      });
    }
    const serialised = JSON.stringify(outcome.response.files);
    expect(serialised).toContain('CONNECTOR_CRM');
    expect(
      JSON.stringify(outcome.response.files.filter((file) => file.path !== 'PLATFORM_REPORT.md')),
    ).not.toContain('CONNECTOR_A_B');
  });

  it('does not count a dropped skill toward the size cap, and never reads it', async () => {
    const { agentId, sources, reads } = await world({
      skills: ['broken', 'triage-guide'],
      skillFiles: {
        broken: [{ path: 'assets/huge.bin', bytes: new Uint8Array(PLATFORM_EXPORT_MAX_BYTES + 1) }],
        'triage-guide': [
          {
            path: 'SKILL.md',
            bytes: encode('---\nname: triage-guide\ndescription: Triage.\n---\nBody\n'),
          },
        ],
      },
    });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    if (!outcome.ok) throw new Error(JSON.stringify(outcome.result.body));
    expect(outcome.response.report).toContainEqual(
      expect.objectContaining({
        path: 'agents.support-triage.skills.0',
        verdict: 'dropped',
      }),
    );
    expect(reads).toStrictEqual(['triage-guide/SKILL.md']);
  });

  it('reports a connector this workspace does not have as dropped', async () => {
    const { agentId, sources } = await world({ connectors: ['missing'] });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    if (!outcome.ok) throw new Error(JSON.stringify(outcome.result.body));
    expect(outcome.response.report).toContainEqual(
      expect.objectContaining({
        path: 'agents.support-triage.definition.resources.connectors.0',
        verdict: 'dropped',
        note: 'this workspace has no connector named missing',
      }),
    );
  });
});

const CLIENT: EndpointClientResource = {
  id: 'c1',
  name: 'ide',
  kind: 'mcp-project',
  agentIds: [],
  toolNames: null,
  redirectUris: [],
  hasClientSecret: false,
  actsForPrincipalId: PRINCIPAL,
  apiKeyIds: [],
  revokedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('toolEndpointOf', () => {
  const origin = 'https://aw.example.com';
  const publishing = (overrides: Partial<EndpointClientResource> = {}): EndpointClientResource => ({
    ...CLIENT,
    agentIds: ['root'],
    ...overrides,
  });

  it('names the one live mcp-project client publishing the agent, with a secret reference', () => {
    expect(toolEndpointOf([publishing()], 'root', origin)).toStrictEqual({
      kind: 'found',
      endpoint: {
        url: 'https://aw.example.com/mcp/projects/ide',
        auth: { scheme: 'bearer', secretRef: 'TOOL_ENDPOINT_IDE' },
      },
    });
  });

  it.each([
    ['a revoked client', [publishing({ revokedAt: '2026-02-01T00:00:00.000Z' })], origin],
    ['an a2a-agent client', [publishing({ kind: 'a2a-agent' })], origin],
    ['a client of another agent', [publishing({ agentIds: ['other'] })], origin],
    ['no public origin', [publishing()], null],
    ['a plain http origin', [publishing()], 'http://localhost:3000'],
  ])('finds no endpoint for %s', (_name, clients, publicOrigin) => {
    expect(toolEndpointOf(clients, 'root', publicOrigin)).toStrictEqual({ kind: 'none' });
  });

  it('reports every publishing client rather than guessing between them', () => {
    expect(
      toolEndpointOf([publishing({ name: 'zed' }), publishing({ name: 'ide' })], 'root', origin),
    ).toStrictEqual({ kind: 'ambiguous', names: ['ide', 'zed'] });
  });
});

describe('exportAgentVersion with subagents, knowledge files and a tool endpoint', () => {
  /** Version 2 of the world's agent, saved past the engine check that refuses subagents today. */
  async function withExtras(
    seeded: World,
    extras: {
      readonly subagents?: readonly string[];
      readonly knowledgePaths?: readonly string[];
    },
  ): Promise<void> {
    const request = versionRequest({
      name: 'support-triage',
      resources: {
        files: (extras.knowledgePaths ?? []).map((path) => ({ path, access: 'read' as const })),
      },
    });
    const created = await seeded.store.create(seeded.agentId, {
      summary: 'extras',
      via: 'api',
      body: {
        ...request.body,
        definition: {
          ...request.body.definition,
          agent: { ...request.body.definition.agent, model: 'claude-sonnet-4-5' },
        },
        ...(extras.subagents === undefined
          ? {}
          : { subagents: extras.subagents.map((name) => ({ name })) }),
        ...(extras.knowledgePaths === undefined
          ? {}
          : { knowledge: [{ kind: 'files' as const, paths: [...extras.knowledgePaths] }] }),
      },
      createdByPrincipalId: PRINCIPAL,
    });
    if (created.kind !== 'created') throw new Error('the memory store creates the version');
  }

  const exportV2 = (
    seeded: World,
    platform = 'claude-managed-agents',
    options?: Record<string, unknown>,
  ): ReturnType<typeof exportAgentVersion> =>
    exportAgentVersion(
      seeded.agentId,
      { version: 2, platform, ...(options === undefined ? {} : { options }) },
      seeded.sources,
    );

  it('carries a subagent at its production version', async () => {
    const seeded = await world();
    await seedAgentVersion(seeded, 'researcher', 'production');
    await withExtras(seeded, { subagents: ['researcher'] });

    const outcome = await exportV2(seeded);

    if (!outcome.ok) throw new Error(JSON.stringify(outcome.result.body));
    expect(JSON.stringify(outcome.response.files)).toContain('researcher');
  });

  it('falls back to the local version when the subagent has no production one', async () => {
    const seeded = await world();
    await seedAgentVersion(seeded, 'researcher', 'local');
    await withExtras(seeded, { subagents: ['researcher'] });

    const outcome = await exportV2(seeded);

    if (!outcome.ok) throw new Error(JSON.stringify(outcome.result.body));
    expect(JSON.stringify(outcome.response.files)).toContain('researcher');
  });

  it.each([
    ['no agent of that name', async () => Promise.resolve()],
    [
      'no version pointed at',
      async (seeded: World) => {
        await seedAgentVersion(seeded, 'researcher', null);
      },
    ],
    [
      'a version of another name',
      async (seeded: World) => {
        await seedAgentVersion(seeded, 'researcher', 'production', { bodyName: 'someone-else' });
      },
    ],
    [
      'a subagent of its own',
      async (seeded: World) => {
        await seedAgentVersion(seeded, 'researcher', 'production', { subagents: ['nested'] });
      },
    ],
  ])('refuses with platform_agent_not_found for %s', async (_name, seed) => {
    const seeded = await world();
    await seed(seeded);
    await withExtras(seeded, { subagents: ['researcher'] });

    const outcome = await exportV2(seeded);

    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.result.status).toBe(422);
    expect(problemOf(outcome.result)).toMatchObject({
      code: 'platform_agent_not_found',
      details: ['support-triage.subagents.researcher'],
    });
  });

  it('carries a granted knowledge file from the workspace', async () => {
    const seeded = await world({
      workspaceFiles: { 'docs/faq.md': encode('Q: how?\nA: like this.\n') },
    });
    await withExtras(seeded, { knowledgePaths: ['docs/faq.md'] });

    const outcome = await exportV2(seeded, 'copilot-studio', { publisherPrefix: 'contoso' });

    if (!outcome.ok) throw new Error(JSON.stringify(outcome.result.body));
    expect(seeded.reads).toContain('docs/faq.md');
    expect(JSON.stringify(outcome.response.files)).toContain('A: like this.');
  });

  it.each([
    ['claude-managed-agents', undefined],
    [
      'gemini-enterprise',
      {
        projectId: 'acme-agents',
        location: 'global',
        engineId: 'acme-support-app',
        publicBaseUrl: 'https://aw.example.com',
      },
    ],
  ])(
    'reports a knowledge file the workspace no longer has instead of failing (%s)',
    async (platform, options) => {
      const seeded = await world();
      await withExtras(seeded, { knowledgePaths: ['docs/gone.md'] });

      const outcome = await exportV2(seeded, platform, options);

      if (!outcome.ok) throw new Error(JSON.stringify(outcome.result.body));
      expect(outcome.response.report).toContainEqual(
        expect.objectContaining({
          path: 'agents.support-triage.knowledge.0',
          verdict: 'dropped',
          note: expect.stringContaining('docs/gone.md') as unknown,
        }),
      );
      expect(outcome.response.files.map((file) => file.path)).not.toContainEqual(
        expect.stringContaining('docs/gone.md'),
      );
    },
  );

  it('counts a knowledge file toward the size cap', async () => {
    const seeded = await world({
      workspaceFiles: { 'docs/huge.md': new Uint8Array(PLATFORM_EXPORT_MAX_BYTES + 1) },
    });
    await withExtras(seeded, { knowledgePaths: ['docs/huge.md'] });

    const outcome = await exportV2(seeded);

    if (outcome.ok) throw new Error('the over-size export is refused');
    expect(outcome.result.status).toBe(422);
    expect(problemOf(outcome.result).code).toBe('platform_export_too_large');
  });

  describe('an OpenAPI connector', () => {
    const CONNECTOR_PATH = 'agents.support-triage.definition.resources.connectors.0';

    async function openApiWorld(
      options: { readonly name?: string; readonly auth?: 'none' | 'bearer' } = {},
    ) {
      const name = options.name ?? 'petstore';
      return world({
        connectors: [name],
        seed: async (connectors) => {
          const created = await createConnector(
            connectors.forWorkspace(WORKSPACE),
            {
              kind: 'openapi',
              name,
              document: PETSTORE,
              allow: ['GET /pets'],
              ...(options.auth === 'bearer' ? { auth: 'bearer', credential: SECRET_SENTINEL } : {}),
            },
            { principalId: PRINCIPAL, userId: null },
            () => Promise.resolve({ ok: true }),
          );
          if (created.status !== 201) throw new Error(JSON.stringify(created.body));
        },
      });
    }

    const noDocument = (sources: PortableProjectSources): PortableProjectSources => ({
      ...sources,
      connectors: { ...sources.connectors, openapiDocument: () => Promise.resolve(null) },
    });

    it('carries the stored document in the project and never drops the connector', async () => {
      const { agentId, sources } = await openApiWorld({ auth: 'bearer' });

      const built = await buildPortableProject(agentId, 1, sources);

      if (!built.ok) throw new Error(JSON.stringify(built.result.body));
      expect(built.project.openapiSpecs).toHaveLength(1);
      const [spec] = built.project.openapiSpecs;
      expect(spec?.content).toBe(PETSTORE);
      expect(spec?.ref).toMatch(/^openapi\/[0-9a-f-]{36}\.yaml$/u);
      expect(built.dropped.map((each) => each.path)).not.toContain(CONNECTOR_PATH);
      const [tool] = built.project.agents[0]?.tools ?? [];
      expect(tool).toMatchObject({
        kind: 'openapi',
        name: 'petstore',
        auth: { secretRef: 'CONNECTOR_PETSTORE' },
      });
      expect(JSON.stringify(built)).not.toContain(SECRET_SENTINEL);
      expect(JSON.stringify(built)).toContain('CONNECTOR_PETSTORE');
    });

    it('is exported to a platform without a dropped verdict for the connector', async () => {
      const { agentId, sources } = await openApiWorld();

      const outcome = await exportAgentVersion(
        agentId,
        { version: 1, platform: 'claude-managed-agents' },
        sources,
      );

      if (!outcome.ok) throw new Error(JSON.stringify(outcome.result.body));
      expect(outcome.response.report).not.toContainEqual(
        expect.objectContaining({ path: CONNECTOR_PATH, verdict: 'dropped' }),
      );
    });

    it.each([
      [
        'its base URL has an unknown query parameter',
        { document: PETSTORE, baseUrl: 'https://93.184.216.34/v1?code=URL-SENTINEL-1234' },
        'the connector petstore: the base URL carries a query, fragment or credential; re-register it without one',
      ],
      [
        "its document's servers[0].url has a query",
        {
          document: PETSTORE.replace(
            'https://{host}/v1',
            'https://{host}/v1?code=URL-SENTINEL-1234',
          ),
          baseUrl: 'https://93.184.216.34/v1',
        },
        'the connector petstore: a server URL in its document carries a query, fragment or credential; replace it with a document without one',
      ],
    ])('is dropped when %s, naming it and never the URL', async (_form, body, note) => {
      const { agentId, sources } = await world({
        connectors: ['petstore'],
        seed: async (connectors) => {
          const created = await createConnector(
            connectors.forWorkspace(WORKSPACE),
            { kind: 'openapi', name: 'petstore', allow: ['GET /pets'], ...body },
            { principalId: PRINCIPAL, userId: null },
            () => Promise.resolve({ ok: true }),
          );
          if (created.status !== 201) throw new Error(JSON.stringify(created.body));
        },
      });

      const outcome = await exportAgentVersion(
        agentId,
        { version: 1, platform: 'claude-managed-agents' },
        sources,
      );

      if (!outcome.ok) throw new Error(JSON.stringify(outcome.result.body));
      expect(outcome.response.report).toContainEqual({
        path: CONNECTOR_PATH,
        verdict: 'dropped',
        code: 'field_unsupported',
        note,
      });
      const report = outcome.response.files.find((file) => file.path === 'PLATFORM_REPORT.md');
      if (report === undefined) throw new Error('the export carries PLATFORM_REPORT.md');
      const text = (file: typeof report): string => new TextDecoder().decode(exportFileBytes(file));
      expect(text(report)).toContain('the connector petstore');
      for (const file of outcome.response.files) {
        expect(text(file)).not.toContain('URL-SENTINEL-1234');
      }
      expect(JSON.stringify(outcome.response)).not.toContain('URL-SENTINEL-1234');
    });

    it('is dropped with a note to register it again when no document is stored', async () => {
      const { agentId, sources } = await openApiWorld();

      const outcome = await exportAgentVersion(
        agentId,
        { version: 1, platform: 'claude-managed-agents' },
        noDocument(sources),
      );

      if (!outcome.ok) throw new Error(JSON.stringify(outcome.result.body));
      expect(outcome.response.report).toContainEqual({
        path: CONNECTOR_PATH,
        verdict: 'dropped',
        code: 'field_unsupported',
        note: 'the connector petstore was registered before Agent Workspace kept OpenAPI documents; replace it with its document and export again',
      });
    });

    it('is dropped, not exported as the wrong spec, when the stored text misses its digest', async () => {
      const { agentId, sources } = await openApiWorld();
      const stale: PortableProjectSources = {
        ...sources,
        connectors: {
          ...sources.connectors,
          openapiDocument: () => Promise.resolve(`${PETSTORE}\n# edited`),
        },
      };

      const built = await buildPortableProject(agentId, 1, stale);

      if (!built.ok) throw new Error(JSON.stringify(built.result.body));
      expect(built.project.openapiSpecs).toEqual([]);
      expect(built.dropped).toContainEqual(
        expect.objectContaining({
          path: CONNECTOR_PATH,
          note: "the connector petstore's stored document does not match its digest; replace it with its document and export again",
        }),
      );
    });

    it('is dropped before its document is read when its name is not a portable tool name', async () => {
      const { agentId, sources } = await openApiWorld({ name: 'Pet Store' });
      const read: string[] = [];
      const watched: PortableProjectSources = {
        ...sources,
        connectors: {
          ...sources.connectors,
          openapiDocument: (id) => {
            read.push(id);
            return sources.connectors.openapiDocument(id);
          },
        },
      };

      const built = await buildPortableProject(agentId, 1, watched);

      if (!built.ok) throw new Error(JSON.stringify(built.result.body));
      expect(read).toEqual([]);
      expect(built.project.openapiSpecs).toEqual([]);
      expect(built.dropped).toContainEqual(
        expect.objectContaining({
          path: CONNECTOR_PATH,
          note: 'the connector Pet Store cannot be a portable tool name (1-64 letters, digits, "_" or "-"); rename it and export again',
        }),
      );
    });

    it("carries a subagent's JSON document under a .json ref", async () => {
      const seeded = await world({
        seed: async (connectors) => {
          const created = await createConnector(
            connectors.forWorkspace(WORKSPACE),
            { kind: 'openapi', name: 'petstore', document: PETSTORE_JSON, allow: ['GET /pets'] },
            { principalId: PRINCIPAL, userId: null },
            () => Promise.resolve({ ok: true }),
          );
          if (created.status !== 201) throw new Error(JSON.stringify(created.body));
        },
      });
      await seedAgentVersion(seeded, 'researcher', 'production', { connectors: ['petstore'] });
      await withExtras(seeded, { subagents: ['researcher'] });

      const built = await buildPortableProject(seeded.agentId, 2, seeded.sources);

      if (!built.ok) throw new Error(JSON.stringify(built.result.body));
      expect(built.project.openapiSpecs).toHaveLength(1);
      const [spec] = built.project.openapiSpecs;
      expect(spec?.content).toBe(PETSTORE_JSON);
      expect(spec?.ref).toMatch(/^openapi\/[0-9a-f-]{36}\.json$/u);
      expect(built.dropped.map((each) => each.path)).not.toContainEqual(
        expect.stringContaining('resources.connectors'),
      );
    });

    it('is dropped when it needs a credential and none is on file', async () => {
      const { agentId, sources } = await openApiWorld({ auth: 'bearer' });
      const uncredentialed: PortableProjectSources = {
        ...sources,
        connectors: {
          ...sources.connectors,
          list: async () =>
            (await sources.connectors.list()).map((each) => ({ ...each, hasCredential: false })),
        },
      };

      const built = await buildPortableProject(agentId, 1, uncredentialed);

      if (!built.ok) throw new Error(JSON.stringify(built.result.body));
      expect(built.project.openapiSpecs).toEqual([]);
      expect(built.dropped).toContainEqual(
        expect.objectContaining({
          path: CONNECTOR_PATH,
          note: 'the connector petstore requires a credential but none is on file; add one and export again',
        }),
      );
    });

    it('is dropped with an MCP connector whose secret name it would share', async () => {
      const seeded = await world({
        connectors: ['a_b', 'a-b'],
        seed: async (connectors) => {
          await seedConnector(connectors, 'a_b', { authType: 'bearer' });
          const created = await createConnector(
            connectors.forWorkspace(WORKSPACE),
            {
              kind: 'openapi',
              name: 'a-b',
              document: PETSTORE,
              allow: ['GET /pets'],
              auth: 'bearer',
              credential: SECRET_SENTINEL,
            },
            { principalId: PRINCIPAL, userId: null },
            () => Promise.resolve({ ok: true }),
          );
          if (created.status !== 201) throw new Error(JSON.stringify(created.body));
        },
      });

      const built = await buildPortableProject(seeded.agentId, 1, seeded.sources);

      if (!built.ok) throw new Error(JSON.stringify(built.result.body));
      expect(built.project.openapiSpecs).toEqual([]);
      expect(built.dropped).toHaveLength(2);
      for (const each of built.dropped) {
        expect(each.note).toContain('would share the secret name CONNECTOR_A_B');
      }
    });

    it('is not exported from another workspace, which cannot see the connector', async () => {
      const { agentId, otherWorkspace } = await openApiWorld();

      const built = await buildPortableProject(agentId, 1, otherWorkspace);

      expect(built.ok).toBe(false);
    });

    it('counts its document toward the size cap with the skills', async () => {
      const skill = encode('---\nname: triage-guide\ndescription: Triage.\n---\nBody\n');
      const { agentId, sources } = await world({
        connectors: ['petstore'],
        skills: ['triage-guide'],
        skillFiles: {
          'triage-guide': [
            { path: 'SKILL.md', bytes: skill },
            {
              path: 'assets/big.bin',
              bytes: new Uint8Array(PLATFORM_EXPORT_MAX_BYTES - skill.byteLength - 10),
            },
          ],
        },
        seed: async (connectors) => {
          const created = await createConnector(
            connectors.forWorkspace(WORKSPACE),
            { kind: 'openapi', name: 'petstore', document: PETSTORE, allow: ['GET /pets'] },
            { principalId: PRINCIPAL, userId: null },
            () => Promise.resolve({ ok: true }),
          );
          if (created.status !== 201) throw new Error(JSON.stringify(created.body));
        },
      });

      await expect(buildPortableProject(agentId, 1, sources)).rejects.toBeInstanceOf(
        PlatformExportTooLargeError,
      );
    });
  });

  it('reports several publishing endpoint clients as a dropped toolEndpoint', async () => {
    const seeded = await world();
    const publishing = (name: string): EndpointClientResource => ({
      ...CLIENT,
      name,
      agentIds: [seeded.agentId],
    });
    const outcome = await exportAgentVersion(
      seeded.agentId,
      { version: 1, platform: 'claude-managed-agents' },
      {
        ...seeded.sources,
        endpointClients: () => Promise.resolve([publishing('a'), publishing('b')]),
      },
    );

    if (!outcome.ok) throw new Error(JSON.stringify(outcome.result.body));
    expect(outcome.response.report).toContainEqual(
      expect.objectContaining({ path: 'toolEndpoint', verdict: 'dropped' }),
    );
  });
});
