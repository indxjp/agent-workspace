/**
 * `POST /api/agents/:id/platform-exports` and `.../platform-archives` (issue #968) through the real
 * route files on the memory stores, with RBAC real: `decide()` answers `403 forbidden` for a Viewer
 * and for a Builder on another principal's agent before any export runs. The full role matrix is
 * `rbac/authorisation-matrix.test.ts`'s, derived from the route declaration.
 */
import { log as webLogger } from '../telemetry/logger';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PLATFORM_EXPORT_MAX_BYTES,
  PLATFORM_EXPORT_REQUEST_MAX_BYTES,
  PlatformExportResponseSchema,
  type PlatformExportResponse,
} from '@indx-workspace/contracts/platforms';
import { decodeUstar } from '@agent-workspace/runtime/transfer';

import { POST as exportsRoute } from '../../app/api/agents/[id]/platform-exports/route';
import { POST as archivesRoute } from '../../app/api/agents/[id]/platform-archives/route';
import { POST as saveVersion } from '../../app/api/agents/[id]/versions/route';
import { FIXTURE_PERMISSIONS, versionRequest } from '../agent-versions/fixtures';
import { createInMemoryAgentVersionStoreProvider } from '../agent-versions/memory-store';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { type WorkspaceResolution } from '../agents/runtime';
import { createInMemoryConnectorsStoreProvider } from '../connectors/memory-store';
import type { EndpointClientsRuntime } from '../endpoint-clients/runtime';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { skillFileKey } from '../skills/keys';
import type { WorkspaceSkillsStoreProvider } from '../storage/store';
import {
  createLocalFilesystemObjectStoreProvider,
  type ObjectStream,
} from '@agent-workspace/core/storage';

const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const OTHER_WORKSPACE = '77777777-7777-4777-8777-777777777777';
const WORKSPACE_HEADER = 'x-test-workspace';
const ACTOR_HEADER = 'x-test-actor';
const MISSING_AGENT = '99999999-9999-4999-8999-999999999999';
const BINARY = Uint8Array.from([0xff, 0xfe, 0x00, 0x80]);
const SKILL_MD = '---\nname: triage-guide\ndescription: Triage.\n---\nBody\n';

const ACTORS = {
  owner: { principalId: 'a0000000-0000-4000-8000-000000000001', role: 'owner' },
  builderA: { principalId: 'a0000000-0000-4000-8000-000000000002', role: 'builder' },
  builderB: { principalId: 'a0000000-0000-4000-8000-000000000003', role: 'builder' },
  viewer: { principalId: 'a0000000-0000-4000-8000-000000000004', role: 'viewer' },
  admin: { principalId: 'a0000000-0000-4000-8000-000000000005', role: 'admin' },
} as const;
type Actor = keyof typeof ACTORS;

let agentOfBuilderA: string;
let skillsRoot: string;

function isActor(value: string): value is Actor {
  return Object.hasOwn(ACTORS, value);
}

type RouteContext = Parameters<typeof exportsRoute>[1];

function post(
  route: typeof exportsRoute,
  options: { actor: Actor | null; id?: string; workspace?: string; body?: unknown; raw?: string },
): Promise<Response> {
  const headers = new Headers({
    [WORKSPACE_HEADER]: options.workspace ?? WORKSPACE,
    'content-type': 'application/json',
  });
  if (options.actor !== null) headers.set(ACTOR_HEADER, options.actor);
  const id = options.id ?? agentOfBuilderA;
  const request = new Request(`https://example.invalid/api/agents/${id}/platform-exports`, {
    method: 'POST',
    headers,
    body:
      options.raw ??
      JSON.stringify(options.body ?? { version: 1, platform: 'claude-managed-agents' }),
  });
  const context: RouteContext = { params: Promise.resolve({ id }) };
  return route(request, context);
}

async function errorOf(response: Response): Promise<{ code: string; details?: string[] }> {
  const body = (await response.json()) as { error: { code: string; details?: string[] } };
  return body.error;
}

function resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
  const workspaceId = request.headers.get(WORKSPACE_HEADER);
  return Promise.resolve(
    workspaceId === null
      ? { kind: 'unauthenticated', reason: 'no test workspace header' }
      : { kind: 'workspace', workspaceId },
  );
}

/** The skills store under `skillsRoot`, with every `read` answered by `read` instead. */
function skillStoreWithRead(
  read: (
    key: string,
    inner: (key: string) => Promise<ObjectStream | null>,
  ) => Promise<ObjectStream | null>,
): WorkspaceSkillsStoreProvider {
  const provider = createLocalFilesystemObjectStoreProvider(skillsRoot);
  return {
    forWorkspace: (workspaceId) => {
      const inner = provider.forWorkspace(workspaceId);
      return {
        delete: (key) => inner.delete(key),
        copy: (source, destination) => inner.copy(source, destination),
        head: (key) => inner.head(key),
        read: (key, options) => read(key, (k) => inner.read(k, options)),
        write: (key, body, options) => inner.write(key, body, options),
        listPage: (prefix, options) => inner.listPage(prefix, options),
      };
    },
  };
}

beforeEach(async () => {
  skillsRoot = await mkdtemp(path.join(os.tmpdir(), 'platform-exports-'));
  const agents = createInMemoryAgentStoreProvider();
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'support-triage',
      instructions: 'Answer support mail.',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
    },
    { principalId: ACTORS.builderA.principalId, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the fixture agent');
  agentOfBuilderA = created.agent.id;

  const skillStore = createLocalFilesystemObjectStoreProvider(skillsRoot);
  const files = skillStore.forWorkspace(WORKSPACE);
  await files.write(skillFileKey('triage-guide', 'SKILL.md'), new TextEncoder().encode(SKILL_MD), {
    contentType: null,
  });
  await files.write(skillFileKey('triage-guide', 'assets/blob.bin'), BINARY, { contentType: null });

  installTestDomains({ agents: { agents, resolveWorkspace } });
  installTestDomains({
    agentVersions: {
      versions: createInMemoryAgentVersionStoreProvider({
        agents,
        references: { [WORKSPACE]: { skill: [{ id: 's1', name: 'triage-guide' }] } },
      }),
    },
  });
  installTestDomains({
    connectors: {
      kind: 'serving',
      runtime: {
        resolveWorkspace,
        connectors: createInMemoryConnectorsStoreProvider(),
        recordAudit: () => Promise.resolve(),
        identifyActor: () => Promise.resolve(null),
      },
    },
    // The export lists the workspace's endpoint clients; this workspace has none.
    endpointClients: {
      list: () => Promise.resolve([]),
    } as Partial<EndpointClientsRuntime> as EndpointClientsRuntime,
  });
  installTestDomains({
    skills: { kind: 'serving', runtime: { resolveWorkspace, store: skillStore } },
  });
  installTestDomains({
    files: { kind: 'serving', runtime: { resolveWorkspace, store: skillStore } },
  });
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory({ users: [] }),
      identify: (request) => {
        const workspaceId = request.headers.get(WORKSPACE_HEADER);
        const actor = request.headers.get(ACTOR_HEADER);
        if (workspaceId === null || actor === null || !isActor(actor)) return Promise.resolve(null);
        return Promise.resolve(
          Principal.fromApiKey({
            ...ACTORS[actor],
            apiKeyId: ACTORS[actor].principalId.replace(/^a/u, 'b'),
            workspaceId,
            label: `${actor} export key`,
          }),
        );
      },
    },
  });

  const request = versionRequest({
    name: 'support-triage',
    resources: { skills: ['triage-guide'] },
  });
  const saved = await saveVersion(
    new Request(`https://example.invalid/api/agents/${agentOfBuilderA}/versions`, {
      method: 'POST',
      headers: {
        [WORKSPACE_HEADER]: WORKSPACE,
        [ACTOR_HEADER]: 'builderA',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...request,
        body: {
          ...request.body,
          definition: {
            ...request.body.definition,
            agent: { ...request.body.definition.agent, model: 'claude-sonnet-4-5' },
          },
        },
      }),
    }),
    { params: Promise.resolve({ id: agentOfBuilderA }) },
  );
  expect(saved.status).toBe(201);
});

afterEach(async () => {
  clearApplicationContext();
  await rm(skillsRoot, { recursive: true, force: true });
});

describe('POST /api/agents/:id/platform-exports', () => {
  it.each(['builderA', 'owner', 'admin'] as const)(
    'lets %s export, with the skill and its bytes',
    async (actor) => {
      const response = await post(exportsRoute, { actor });

      expect(response.status).toBe(200);
      const exported = PlatformExportResponseSchema.parse(await response.json());
      expect(exported).toMatchObject({
        agentId: agentOfBuilderA,
        version: 1,
        platform: 'claude-managed-agents',
      });
      const blob = exported.files.find((file) => file.path.endsWith('assets/blob.bin'));
      expect(blob).toMatchObject({
        encoding: 'base64',
        content: Buffer.from(BINARY).toString('base64'),
      });
      expect(exported.files.some((file) => file.path === 'PLATFORM_REPORT.md')).toBe(true);
    },
  );

  it('refuses a Viewer and a Builder on another principal agent with 403 forbidden', async () => {
    for (const actor of ['viewer', 'builderB'] as const) {
      const response = await post(exportsRoute, { actor });
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe('forbidden');
    }
  });

  it('answers 401 to a caller with no credential', async () => {
    expect((await post(exportsRoute, { actor: null })).status).toBe(401);
  });

  it('refuses an id that is not a UUID with 400 invalid_agent_id', async () => {
    const response = await post(exportsRoute, { actor: 'builderA', id: 'not-a-uuid' });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_agent_id');
  });

  it('conceals an agent of another workspace as 404 agent_not_found', async () => {
    const response = await post(exportsRoute, { actor: 'builderA', workspace: OTHER_WORKSPACE });
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('agent_not_found');
    const missing = await post(exportsRoute, { actor: 'builderA', id: MISSING_AGENT });
    expect(missing.status).toBe(404);
  });

  it('answers 404 [version:9] for an unsaved version', async () => {
    const response = await post(exportsRoute, {
      actor: 'builderA',
      body: { version: 9, platform: 'claude-managed-agents' },
    });
    expect(response.status).toBe(404);
    expect(await errorOf(response)).toMatchObject({
      code: 'agent_version_not_found',
      details: ['version:9'],
    });
  });

  it('answers 400 invalid_platform_export with path: message details', async () => {
    const response = await post(exportsRoute, {
      actor: 'builderA',
      body: { version: 1, platform: 'nowhere' },
    });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe('invalid_platform_export');
    expect(error.details?.[0]).toMatch(/^platform: /u);
  });

  it('refuses a body over the request cap with 413', async () => {
    const response = await post(exportsRoute, {
      actor: 'builderA',
      raw: JSON.stringify({
        version: 1,
        platform: 'copilot-studio',
        pad: 'x'.repeat(PLATFORM_EXPORT_REQUEST_MAX_BYTES),
      }),
    });
    expect(response.status).toBe(413);
  });

  it('refuses an over-size skill tree with 422 from its listed sizes, before reading its bytes', async () => {
    await createLocalFilesystemObjectStoreProvider(skillsRoot)
      .forWorkspace(WORKSPACE)
      .write(
        skillFileKey('triage-guide', 'assets/huge.bin'),
        new Uint8Array(PLATFORM_EXPORT_MAX_BYTES),
        { contentType: null },
      );
    const reads: string[] = [];
    const store = skillStoreWithRead((key, read) => {
      reads.push(key);
      return read(key);
    });
    installTestDomains({ skills: { kind: 'serving', runtime: { resolveWorkspace, store } } });

    const response = await post(exportsRoute, { actor: 'builderA' });

    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe('platform_export_too_large');
    expect(reads).toStrictEqual([]);
  });

  it('fails with 500 rather than exporting a partial skill when a listed file is gone', async () => {
    const blobKey = skillFileKey('triage-guide', 'assets/blob.bin');
    const store = skillStoreWithRead((key, read) =>
      key === blobKey ? Promise.resolve(null) : read(key),
    );
    installTestDomains({ skills: { kind: 'serving', runtime: { resolveWorkspace, store } } });

    const log = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);

    const response = await post(exportsRoute, { actor: 'builderA' });

    expect(response.status).toBe(500);
    expect(await errorOf(response)).toEqual({
      code: 'internal_error',
      message: 'The request could not be completed.',
    });
    expect(log).toHaveBeenCalledWith('[platforms] export failed', {
      error: expect.objectContaining({
        cause: expect.objectContaining({
          message: expect.stringMatching(/listed but could not/u) as unknown,
        }) as unknown,
      }) as unknown,
    });
    log.mockRestore();
  });

  it('answers 503 when the skills store is not configured', async () => {
    installTestDomains({ skills: { kind: 'unavailable' } });
    const response = await post(exportsRoute, { actor: 'builderA' });
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('agent_policy_not_configured');
  });
});

describe('POST /api/agents/:id/platform-archives', () => {
  it('serves the same files as the JSON export, as a tar named for the agent', async () => {
    const json = (await (
      await post(exportsRoute, { actor: 'builderA' })
    ).json()) as PlatformExportResponse;

    const response = await post(archivesRoute, { actor: 'builderA' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-tar');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="support-triage-claude-managed-agents-v1.tar"',
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const entries = decodeUstar(new Uint8Array(await response.arrayBuffer()));
    expect(entries.map((entry) => entry.path)).toStrictEqual(json.files.map((file) => file.path));
    for (const file of json.files) {
      const entry = entries.find((candidate) => candidate.path === file.path);
      expect(
        Buffer.from(entry?.data ?? []).toString(file.encoding === 'utf8' ? 'utf8' : 'base64'),
      ).toBe(file.content);
    }
  });

  it('refuses a Viewer with 403 and a bad body with 400, as JSON', async () => {
    expect((await post(archivesRoute, { actor: 'viewer' })).status).toBe(403);
    const bad = await post(archivesRoute, { actor: 'builderA', body: { version: 'one' } });
    expect(bad.status).toBe(400);
    expect(bad.headers.get('content-type')).toContain('application/json');
  });
});
