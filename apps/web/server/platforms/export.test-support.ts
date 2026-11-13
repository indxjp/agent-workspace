import { readFileSync } from 'node:fs';
import type { EndpointClientResource } from '@indx-workspace/contracts/endpoint-clients';
import { createInMemoryAgentVersionStoreProvider } from '../agent-versions/memory-store';
import { versionRequest } from '../agent-versions/fixtures';
import { createAgentVersion } from '../agent-versions/handlers';
import { FIXTURE_PERMISSIONS } from '../agent-versions/fixtures';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { createInMemoryConnectorsStoreProvider } from '../connectors/memory-store';
import type { WorkspaceAgentVersionStore } from '../agent-versions/store';
import type { ApiResult } from '../http/result';
import { exportAgentVersion } from './export';
import { buildPortableProject, type PortableProjectSources } from './project';

export const WORKSPACE = '66666666-6666-4666-8666-666666666666';

export const PRINCIPAL = '36377a6a-7a0b-4610-8efc-d31547dcc38a';

export const SECRET_SENTINEL = 'sk-sentinel-DO-NOT-LEAK-0123456789';

export const PETSTORE = readFileSync(
  new URL('../openapi/fixtures/petstore-3.0.yaml', import.meta.url),
  'utf8',
);

export const PETSTORE_JSON = readFileSync(
  new URL('../openapi/fixtures/petstore-3.0.json', import.meta.url),
  'utf8',
);

export const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

export interface SkillFileBytes {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface World {
  readonly agentId: string;
  readonly reads: string[];
  readonly sources: PortableProjectSources;
  readonly otherWorkspace: PortableProjectSources;
  readonly store: WorkspaceAgentVersionStore;
  readonly provider: ReturnType<typeof createInMemoryAgentVersionStoreProvider>;
  readonly agents: ReturnType<typeof createInMemoryAgentStoreProvider>;
}

export async function world(
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
  const skillFiles = skillFileSource(options, reads);
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
export async function seedAgentVersion(
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

export async function seedConnector(
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

export function problemOf(result: ApiResult): { code: string; details?: string[] } {
  const error = (result.body as { error: { code: string; details?: string[] } }).error;
  return error;
}

export const CLIENT: EndpointClientResource = {
  id: 'c1',
  name: 'ide',
  kind: 'mcp-project',
  agentIds: [],
  toolNames: null,
  redirectUris: [],
  oidcAudience: null,
  hasClientSecret: false,
  actsForPrincipalId: PRINCIPAL,
  apiKeyIds: [],
  revokedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

export async function withExtras(
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

export const exportV2 = (
  seeded: World,
  platform = 'claude-managed-agents',
  options?: Record<string, unknown>,
): ReturnType<typeof exportAgentVersion> =>
  exportAgentVersion(
    seeded.agentId,
    { version: 2, platform, ...(options === undefined ? {} : { options }) },
    seeded.sources,
  );

export function assertExported(
  outcome: Awaited<ReturnType<typeof exportAgentVersion>>,
): asserts outcome is Extract<Awaited<ReturnType<typeof exportAgentVersion>>, { ok: true }> {
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.result.body));
}

export function assertProjectBuilt(
  built: Awaited<ReturnType<typeof buildPortableProject>>,
): asserts built is Extract<Awaited<ReturnType<typeof buildPortableProject>>, { ok: true }> {
  if (!built.ok) throw new Error(JSON.stringify(built.result.body));
}

export function skillFileSource(
  options: Parameters<typeof world>[0],
  reads: string[],
): PortableProjectSources['skillFiles'] {
  const skillFiles: PortableProjectSources['skillFiles'] = (name) =>
    Promise.resolve(
      (options?.skillFiles?.[name] ?? []).map((file) => ({
        path: file.path,
        sizeBytes: file.bytes.byteLength,
        read: () => {
          reads.push(`${name}/${file.path}`);
          return Promise.resolve(file.bytes);
        },
      })),
    );

  return skillFiles;
}
