import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';

import { AgentPointerMoveResponseSchema } from '@indx-workspace/contracts/agent-versions';
import { AW_DEV_TOOLS_CONNECTOR } from '@indx-workspace/contracts/tool-connectors';

import { POST as promote } from './route';
import { POST as rollback } from '../rollback/route';
import { createInMemoryAgentStoreProvider } from '../../../../../server/agents/memory-store';
import type { AgentRecord } from '../../../../../server/agents/contract';
import { type WorkspaceResolution } from '../../../../../server/agents/runtime';
import { FIXTURE_PERMISSIONS, versionRequest } from '../../../../../server/agent-versions/fixtures';
import { createAgentVersion } from '../../../../../server/agent-versions/handlers';
import {
  createInMemoryAgentVersionStoreProvider,
  type InMemoryAgentVersionStoreProvider,
} from '../../../../../server/agent-versions/memory-store';
import { setAgentPointer } from '../../../../../server/agent-versions/pointers';
import { clearApplicationContext } from '../../../../../server/application-context';
import { installTestDomains } from '../../../../../server/application-context-fixtures';
import type { WorkspaceAgentVersionStore } from '../../../../../server/agent-versions/store';
import { createLocalFilesystemObjectStoreProvider } from '@agent-workspace/core/storage';
import { createRepositorySkillsStoreProvider } from '../../../../../server/storage/store';
import { uploadToolBundle } from '../../../../../server/tool-bundles/handlers';
import type { CeilingFor } from '../../../../../server/policy-ceiling/ceiling';
import { createMemoryDirectory } from '../../../../../server/rbac/memory-directory';
import { Principal } from '../../../../../server/rbac/principal';

/**
 * `POST /api/agents/:id/promote` and `POST /api/agents/:id/rollback` (issue #615) on the memory
 * stores, driven with real `Request` objects and real RBAC. The PostgreSQL proof of the same moves
 * is `promote.postgres.test.ts`.
 */
const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const OTHER_WORKSPACE = '77777777-7777-4777-8777-777777777777';
const WORKSPACE_HEADER = 'x-test-workspace';
const ACTOR_HEADER = 'x-test-actor';

const ACTORS = {
  builderA: { principalId: 'a0000000-0000-4000-8000-000000000002', role: 'builder' },
  viewer: { principalId: 'a0000000-0000-4000-8000-000000000004', role: 'viewer' },
  admin: { principalId: 'a0000000-0000-4000-8000-000000000005', role: 'admin' },
} as const;
type Actor = keyof typeof ACTORS;
type Route = typeof promote;

let versions: InMemoryAgentVersionStoreProvider;
let store: WorkspaceAgentVersionStore;
let agent: AgentRecord;

function isActor(value: string): value is Actor {
  return Object.hasOwn(ACTORS, value);
}

beforeEach(async () => {
  const agents = createInMemoryAgentStoreProvider();
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'Support triage',
      instructions: 'Before any version.',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
    },
    { principalId: ACTORS.builderA.principalId, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the fixture agent');
  agent = created.agent;
  versions = createInMemoryAgentVersionStoreProvider({
    agents,
    references: { [WORKSPACE]: { connector: [{ id: 'c1', name: AW_DEV_TOOLS_CONNECTOR }] } },
  });
  const opened = await versions.forWorkspace(WORKSPACE);
  if (opened === null) throw new Error('the memory store answers every workspace');
  store = opened;
  for (const instructions of ['Version one.', 'Version two.']) {
    const saved = await createAgentVersion(
      versionRequest({ instructions }),
      agent,
      ACTORS.builderA.principalId,
      { store },
    );
    if (saved.status !== 201) throw new Error('the fixture version saves');
  }

  installTestDomains({
    agents: {
      agents,
      resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
        const workspaceId = request.headers.get(WORKSPACE_HEADER);
        return Promise.resolve(
          workspaceId === null
            ? { kind: 'unauthenticated', reason: 'no test workspace header' }
            : { kind: 'workspace', workspaceId },
        );
      },
    },
  });
  installTestDomains({ agentVersions: { versions } });
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
            label: `${actor} release key`,
          }),
        );
      },
    },
  });
});

afterEach(() => {
  clearApplicationContext();
});

function post(
  route: Route,
  options: { actor?: Actor; workspace?: string; body: unknown },
): Promise<Response> {
  const sub = route === promote ? 'promote' : 'rollback';
  const request = new Request(`https://example.invalid/api/agents/${agent.id}/${sub}`, {
    method: 'POST',
    headers: new Headers({
      [WORKSPACE_HEADER]: options.workspace ?? WORKSPACE,
      [ACTOR_HEADER]: options.actor ?? 'builderA',
      'content-type': 'application/json',
    }),
    body: JSON.stringify(options.body),
  });
  return route(request, { params: Promise.resolve({ id: agent.id }) });
}

async function moved(response: Response): Promise<unknown> {
  expect(response.status).toBe(200);
  return AgentPointerMoveResponseSchema.parse(await response.json());
}

async function codeOf(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  const error: unknown = body.error;
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/** Point `local` at `version` the way `aw push` does. */
async function pointLocal(version: number): Promise<void> {
  const result = await setAgentPointer(
    { environment: 'local', version },
    agent,
    { principalId: ACTORS.builderA.principalId, userId: null, actor: 'builderA release key' },
    { store },
  );
  if (result.status !== 200) throw new Error(`local did not move: ${String(result.status)}`);
}

async function pointers(): Promise<readonly (readonly [string, number])[]> {
  const listing = await store.list(agent.id);
  return (listing?.pointers ?? []).map((row) => [row.environment, row.number] as const);
}

describe('POST /api/agents/:id/promote', () => {
  it("dry-runs, then points production at local's version (#615 demo: v1 -> v2)", async () => {
    await pointLocal(1);
    await expect(moved(await post(promote, { body: {} }))).resolves.toEqual({
      environment: 'production',
      from: null,
      to: 1,
      saved: true,
      bar: null,
    });
    await pointLocal(2);
    const audits = versions.audits().length;

    await expect(moved(await post(promote, { body: { dryRun: true } }))).resolves.toEqual({
      environment: 'production',
      from: 1,
      to: 2,
      saved: false,
      bar: null,
    });
    expect(await pointers()).toEqual([
      ['local', 2],
      ['production', 1],
    ]);
    expect(versions.audits()).toHaveLength(audits);

    await expect(moved(await post(promote, { actor: 'admin', body: {} }))).resolves.toEqual({
      environment: 'production',
      from: 1,
      to: 2,
      saved: true,
      bar: null,
    });
    expect(await pointers()).toEqual([
      ['local', 2],
      ['production', 2],
    ]);
    expect(versions.audits().at(-1)?.subjectLabel).toBe(
      'Support triage: production -> version 2 (promote)',
    );
  });

  it('promotes the version the body names', async () => {
    await pointLocal(2);
    await expect(moved(await post(promote, { body: { version: 1 } }))).resolves.toMatchObject({
      from: null,
      to: 1,
    });
  });

  it('answers 409 no_pointer while local points at nothing, and writes nothing', async () => {
    const response = await post(promote, { body: {} });
    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe('no_pointer');
    expect(versions.pointerCount()).toBe(0);
  });

  it('answers 404 agent_version_not_found for a version the agent does not have', async () => {
    await pointLocal(1);
    const response = await post(promote, { body: { version: 9 } });
    expect(response.status).toBe(404);
    expect(await codeOf(response)).toBe('agent_version_not_found');
  });
});

describe('POST /api/agents/:id/promote: the promotion gate (issue #619)', () => {
  /** The deployment's ceiling sets only the bar. */
  const ceilingFor: CeilingFor = () => ({
    policy: { promotion: { minEvalScore: 0.9 } },
    deploymentDefaultModel: () => Promise.resolve(null),
    connectorNames: () => Promise.resolve([]),
    recordRefusal: () => Promise.resolve(),
  });

  beforeEach(() => {
    installTestDomains({ agentVersions: { versions, ceiling: { kind: 'enforced', ceilingFor } } });
  });

  async function idOf(number: number): Promise<string> {
    const id = (await store.list(agent.id))?.versions.find((row) => row.number === number)?.id;
    if (id === undefined) throw new Error(`version ${String(number)} is saved`);
    return id;
  }

  async function problemOf(response: Response): Promise<unknown> {
    expect(response.status).toBe(409);
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined;
  }

  it('refuses an unevaluated version with 409 promotion_not_evaluated, dry run or not', async () => {
    await pointLocal(1);
    for (const body of [{ dryRun: true }, {}]) {
      await expect(problemOf(await post(promote, { body }))).resolves.toMatchObject({
        code: 'promotion_not_evaluated',
        details: ['version:1', 'bar:0.9'],
      });
    }
    expect(await pointers()).toEqual([['local', 1]]);
    expect(await store.listMoves(agent.id, 'production', 10)).toEqual([]);
  });

  it('refuses below the bar naming the failing cases; a newer passing evaluation lets it through', async () => {
    await pointLocal(2);
    versions.recordEvaluation(await idOf(2), {
      score: 0.7,
      passed: 7,
      total: 10,
      failing: ['no refund promises'],
    });
    await expect(problemOf(await post(promote, { body: {} }))).resolves.toMatchObject({
      code: 'promotion_gate_failed',
      details: ['version:2', 'score:0.7', 'bar:0.9', 'case:no refund promises'],
    });
    expect(await pointers()).toEqual([['local', 2]]);

    versions.recordEvaluation(await idOf(2), { score: 1, passed: 10, total: 10, failing: [] });
    await expect(moved(await post(promote, { body: {} }))).resolves.toEqual({
      environment: 'production',
      from: null,
      to: 2,
      saved: true,
      bar: 0.9,
    });
  });

  it("does not let version 1's evaluation unlock version 2", async () => {
    await pointLocal(2);
    versions.recordEvaluation(await idOf(1), { score: 1, passed: 10, total: 10, failing: [] });
    await expect(problemOf(await post(promote, { body: {} }))).resolves.toMatchObject({
      code: 'promotion_not_evaluated',
      details: ['version:2', 'bar:0.9'],
    });
    await expect(moved(await post(promote, { body: { version: 1 } }))).resolves.toMatchObject({
      to: 1,
      bar: 0.9,
    });
  });

  it('never gates a rollback', async () => {
    for (const number of [1, 2]) {
      versions.recordEvaluation(await idOf(number), { score: 1, passed: 1, total: 1, failing: [] });
      await pointLocal(number);
      await moved(await post(promote, { body: {} }));
    }
    versions.recordEvaluation(await idOf(1), { score: 0, passed: 0, total: 1, failing: ['a'] });
    await expect(moved(await post(rollback, { body: {} }))).resolves.toMatchObject({
      to: 1,
      bar: null,
    });
  });
});

describe('POST /api/agents/:id/rollback', () => {
  it('rolls production back to the previous version in one request, and never forward (BH061-004)', async () => {
    await pointLocal(1);
    await moved(await post(promote, { body: {} }));
    await pointLocal(2);
    await moved(await post(promote, { body: {} }));

    await expect(moved(await post(rollback, { body: { dryRun: true } }))).resolves.toEqual({
      environment: 'production',
      from: 2,
      to: 1,
      saved: false,
      bar: null,
    });
    expect(await pointers()).toEqual([
      ['local', 2],
      ['production', 2],
    ]);

    await expect(moved(await post(rollback, { body: {} }))).resolves.toEqual({
      environment: 'production',
      from: 2,
      to: 1,
      saved: true,
      bar: null,
    });
    expect(await pointers()).toEqual([
      ['local', 2],
      ['production', 1],
    ]);
    expect(versions.audits().at(-1)?.subjectLabel).toBe(
      'Support triage: production -> version 1 (rollback)',
    );
    const second = await post(rollback, { body: {} });
    expect(second.status).toBe(409);
    expect(await codeOf(second)).toBe('nothing_to_roll_back');
    const history = await store.listMoves(agent.id, 'production', 10);
    expect(history.map((row) => [row.number, row.reason])).toEqual([
      [1, 'rollback'],
      [2, 'promote'],
      [1, 'promote'],
    ]);
  });

  it('rolls local back when the body names it', async () => {
    await pointLocal(1);
    await pointLocal(2);
    await expect(moved(await post(rollback, { body: { environment: 'local' } }))).resolves.toEqual({
      environment: 'local',
      from: 2,
      to: 1,
      saved: true,
      bar: null,
    });
    expect((await store.list(agent.id))?.pointers[0]).toMatchObject({ number: 1 });
  });

  it.each([0, 1])(
    'answers 409 nothing_to_roll_back with %i history entries, and writes nothing',
    async (entries) => {
      if (entries === 1) await pointLocal(1);
      if (entries === 1) await moved(await post(promote, { body: {} }));
      const count = versions.pointerCount();
      const moves = (await store.listMoves(agent.id, null, 10)).length;
      const response = await post(rollback, { body: {} });
      expect(response.status).toBe(409);
      expect(await codeOf(response)).toBe('nothing_to_roll_back');
      expect(versions.pointerCount()).toBe(count);
      expect(await store.listMoves(agent.id, null, 10)).toHaveLength(moves);
    },
  );
});

describe.each([
  ['promote', promote],
  ['rollback', rollback],
] as const)('POST /api/agents/:id/%s refusals', (_name, route) => {
  it('refuses a Viewer with 403 forbidden before the handler', async () => {
    await pointLocal(1);
    const response = await post(route, { actor: 'viewer', body: {} });
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe('forbidden');
  });

  it('answers 404 agent_not_found to another workspace, which never sees the agent', async () => {
    await pointLocal(1);
    await pointLocal(2);
    const response = await post(route, { actor: 'admin', workspace: OTHER_WORKSPACE, body: {} });
    expect(response.status).toBe(404);
    expect(await codeOf(response)).toBe('agent_not_found');
    expect(await pointers()).toEqual([['local', 2]]);
    const other = await versions.forWorkspace(OTHER_WORKSPACE);
    await expect(other?.listMoves(agent.id, null, 10)).resolves.toEqual([]);
  });

  it('answers 400 invalid_agent_version for an unknown key or dryRun false', async () => {
    for (const body of [{ surprise: true }, { dryRun: false }]) {
      const response = await post(route, { body });
      expect(response.status).toBe(400);
      expect(await codeOf(response)).toBe('invalid_agent_version');
    }
  });
});

describe('POST /api/agents/:id/promote: code tools (ADR-0118 TS8)', () => {
  const BUNDLE = Buffer.from('export default () => 1;');
  const DIGEST = createHash('sha256').update(BUNDLE).digest('hex');
  let skillsRoot: string;

  beforeEach(async () => {
    skillsRoot = await mkdtemp(path.join(os.tmpdir(), 'b4-promote-'));
    const skills = createRepositorySkillsStoreProvider({
      store: createLocalFilesystemObjectStoreProvider(skillsRoot),
      scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]),
    });
    installTestDomains({
      skills: {
        kind: 'serving',
        runtime: {
          store: skills,
          resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
        },
      },
    });
    const uploaded = await uploadToolBundle(skills.forWorkspace(WORKSPACE), {
      contentBase64: BUNDLE.toString('base64'),
    });
    if (uploaded.status !== 201) throw new Error('the fixture bundle uploads');
    const everyStored = (): Promise<readonly string[]> => Promise.resolve([]);
    const saved = await createAgentVersion(
      versionRequest({
        instructions: 'Version three.',
        resources: { connectors: [AW_DEV_TOOLS_CONNECTOR] },
        toolBundles: [
          {
            tool: 'lookup',
            digest: DIGEST,
            description: 'Look a ticket up.',
            inputSchema: { type: 'object' },
          },
        ],
      }),
      agent,
      ACTORS.builderA.principalId,
      { store, toolBundles: everyStored },
    );
    if (saved.status !== 201) throw new Error('the code-tool version saves');
    const local = await setAgentPointer(
      { environment: 'local', version: 3 },
      agent,
      { principalId: ACTORS.builderA.principalId, userId: null, actor: 'builderA release key' },
      { store, toolBundles: everyStored },
    );
    if (local.status !== 200) throw new Error('local points at the code-tool version');
  });

  afterEach(async () => {
    await rm(skillsRoot, { recursive: true, force: true });
  });

  it('refuses code_tool_needs_host by default and promotes once the deployment has a tool host', async () => {
    const refused = await post(promote, { body: {} });
    expect(refused.status).toBe(422);
    expect(await codeOf(refused)).toBe('code_tool_needs_host');
    expect(await pointers()).toEqual([['local', 3]]);

    installTestDomains({ agentVersions: { versions, toolHost: true } });
    await expect(moved(await post(promote, { body: {} }))).resolves.toMatchObject({
      environment: 'production',
      to: 3,
      saved: true,
    });
    expect(await pointers()).toEqual([
      ['local', 3],
      ['production', 3],
    ]);
  });
});
