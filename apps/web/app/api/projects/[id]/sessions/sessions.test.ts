import type {
  AgentRecord,
  AgentRepository,
  AgentVersionPointerRecord,
  AuditEventRepository,
  EnsureSessionInput,
  EnsureSessionOutcome,
  ProjectFileRepository,
  ProjectMcpServerRepository,
  ProjectRecord,
  ProjectRepository,
  SessionRecord,
  SessionRepository,
} from '@agent-workspace/core/db';
import { afterEach, describe, expect, it } from 'vitest';

import { createMemoryDirectory } from '../../../../../server/rbac/memory-directory';
import { Principal } from '../../../../../server/rbac/principal';
import { POST } from './route';
import { installTestDomains } from '../../../../../server/application-context-fixtures';
import { clearApplicationContext } from '../../../../../server/application-context';

const WORKSPACE = '55555555-5555-4555-8555-555555555555';
const WORKSPACE_HEADER = 'x-test-workspace';
const ACTOR_HEADER = 'x-test-actor';
const BUILDER_A_PRINCIPAL_ID = 'a7367c68-ea61-4b03-bbf1-3cfd0fcac445';
const BUILDER_B_PRINCIPAL_ID = 'bf655e39-5833-4ea7-a8d9-28337906dc54';

function principalIdFor(actor: string): string {
  return actor === 'builder-a@example.test' ? BUILDER_A_PRINCIPAL_ID : BUILDER_B_PRINCIPAL_ID;
}

function agentRecord(id: string): AgentRecord {
  return {
    id,
    workspaceId: WORKSPACE,
    name: 'Agent',
    instructions: '',
    modelConnectionId: null,
    model: null,
    runtimeProfileId: null,
    permissions: {
      readFiles: true,
      writeFiles: true,
      runCommands: true,
      unrestrictedNetwork: true,
    },
    policy: null,
    createdBy: 'builder-a@example.test',
    ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

interface Fixture {
  agents: Map<string, AgentRecord>;
  projects: Map<string, ProjectRecord>;
  sessions: Map<string, SessionRecord>;
  /** Session ids that have at least one run — mirrors the `runs` table `moveSession` checks. */
  sessionsWithRuns: Set<string>;
  /** Each versioned agent's pointers; an agent absent here is a legacy, unversioned one. */
  pointers: Map<string, readonly AgentVersionPointerRecord[]>;
}

/** The narrow slice of each repository `POST /api/projects/:id/sessions` actually calls. */
function useMemoryRuntime(): Fixture {
  const fixture: Fixture = {
    agents: new Map(),
    projects: new Map(),
    sessions: new Map(),
    sessionsWithRuns: new Set(),
    pointers: new Map(),
  };
  const agentVersions = {
    list: (agentId: string) =>
      Promise.resolve({
        versions: [],
        pointers: fixture.pointers.get(agentId) ?? [],
        materialisedVersionId: null,
      }),
  };

  const projects: ProjectRepository = {
    list: () => Promise.resolve([...fixture.projects.values()]),
    get: (id) => Promise.resolve(fixture.projects.get(id) ?? null),
    create: () => Promise.reject(new Error('unused')),
    createWithAssociations: () => Promise.reject(new Error('unused')),
    update: () => Promise.reject(new Error('unused')),
    updateWithAssociations: () => Promise.reject(new Error('unused')),
    moveSession: (projectId, sessionId) => {
      const session = fixture.sessions.get(sessionId);
      if (session === undefined || !fixture.projects.has(projectId))
        return Promise.resolve({ kind: 'not-found' });
      // Mirrors `moveSession`'s own guard in packages/core/src/db/repositories/projects.ts: a
      // session that already has a run never moves, so its runs' project attribution stays
      // historical.
      if (fixture.sessionsWithRuns.has(sessionId)) return Promise.resolve({ kind: 'has-runs' });
      fixture.sessions.set(sessionId, { ...session, projectId });
      return Promise.resolve({ kind: 'moved' });
    },
    archive: () => Promise.reject(new Error('unused')),
    restore: () => Promise.reject(new Error('unused')),
  };
  const files: ProjectFileRepository = {
    list: () => Promise.resolve([]),
    add: () => Promise.reject(new Error('unused')),
    remove: () => Promise.reject(new Error('unused')),
  };
  const mcpServers: ProjectMcpServerRepository = {
    list: () => Promise.resolve([]),
    add: () => Promise.reject(new Error('unused')),
    remove: () => Promise.reject(new Error('unused')),
  };
  const audit: AuditEventRepository = {
    write: () => Promise.resolve(),
    count: () => Promise.reject(new Error('unused')),
    list: () => Promise.reject(new Error('unused')),
  };
  const agents: AgentRepository = {
    list: () => Promise.reject(new Error('unused')),
    get: (id) => Promise.resolve(fixture.agents.get(id) ?? null),
    create: () => Promise.reject(new Error('unused')),
    createWithAssignments: () => Promise.reject(new Error('unused')),
    update: () => Promise.reject(new Error('unused')),
    delete: () => Promise.reject(new Error('unused')),
    replacePolicy: () => Promise.reject(new Error('unused')),
  };
  let sessionSeq = 0;
  const sessions: SessionRepository = {
    ensure: (input: EnsureSessionInput): Promise<EnsureSessionOutcome> => {
      if (!fixture.agents.has(input.agentId)) {
        return Promise.resolve({ kind: 'unknown-agent', agentId: input.agentId });
      }
      sessionSeq += 1;
      const record: SessionRecord = {
        engine: null,
        agentVersionId: input.agentVersionId ?? null,
        id: input.id,
        workspaceId: WORKSPACE,
        agentId: input.agentId,
        userId: input.userId ?? null,
        ownerPrincipalId: input.ownerPrincipalId,
        projectId: input.projectId ?? null,
        engineSessionId: null,
        title: input.title ?? null,
        status: 'active',
        createdAt: new Date(sessionSeq),
        updatedAt: new Date(sessionSeq),
      };
      fixture.sessions.set(record.id, record);
      return Promise.resolve({ kind: 'created', session: record });
    },
    get: (id) => Promise.resolve(fixture.sessions.get(id) ?? null),
    getByEngineSessionId: () => Promise.reject(new Error('unused')),
    list: () => Promise.reject(new Error('unused')),
    update: () => Promise.reject(new Error('unused')),
    archive: () => Promise.reject(new Error('unused')),
    restore: () => Promise.reject(new Error('unused')),
    discardIfUnused: () => Promise.resolve(false),
  };

  installTestDomains({
    projects: {
      resolveActor: (request) => {
        const workspaceId = request.headers.get(WORKSPACE_HEADER);
        const actor = request.headers.get(ACTOR_HEADER);
        return Promise.resolve(
          workspaceId === null || actor === null
            ? { kind: 'unauthenticated', reason: 'no test workspace header' }
            : {
                kind: 'workspace',
                workspaceId,
                principalId: principalIdFor(actor),
                ownerPrincipalId: principalIdFor(actor),
                userId: actor,
                userLabel: actor,
              },
        );
      },
      forWorkspace: () =>
        Promise.resolve({ projects, files, mcpServers, audit, agents, sessions, agentVersions }),
    },
  });

  installTestDomains({
    rbac: {
      directory: createMemoryDirectory({
        users: [
          { email: 'builder-a@example.test', name: 'A', workspaceId: WORKSPACE, role: 'builder' },
          { email: 'builder-b@example.test', name: 'B', workspaceId: WORKSPACE, role: 'builder' },
        ],
      }),
      identify: (request) => {
        const workspaceId = request.headers.get(WORKSPACE_HEADER);
        const actor = request.headers.get(ACTOR_HEADER);
        return Promise.resolve(
          workspaceId === null || actor === null
            ? null
            : Principal.fromApiKey({
                principalId: principalIdFor(actor),
                apiKeyId:
                  actor === 'builder-a@example.test'
                    ? '9a5f38dd-dc4f-4b8d-8ccb-7e4578489b01'
                    : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                workspaceId,
                role: 'builder',
                label:
                  actor === 'builder-a@example.test'
                    ? 'Builder A session key'
                    : 'Builder B session key',
              }),
        );
      },
    },
  });

  return fixture;
}

function request(url: string, body: unknown, actor = 'builder-a@example.test'): Request {
  return new Request(`https://example.invalid${url}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [WORKSPACE_HEADER]: WORKSPACE,
      [ACTOR_HEADER]: actor,
    },
    body: JSON.stringify(body),
  });
}

function idContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('POST /api/projects/:id/sessions (issue #125)', () => {
  afterEach(() => {
    clearApplicationContext();
  });

  it("starts a session, resolving and persisting the project's default agent in the same write", async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('agent-1', agentRecord('agent-1'));
    fixture.projects.set('project-1', {
      id: 'project-1',
      workspaceId: WORKSPACE,
      name: 'P',
      instructions: null,
      defaultAgentId: 'agent-1',
      visibility: 'private',
      defaultModelConnectionId: null,
      defaultModel: null,
      createdBy: 'builder-a@example.test',
      ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await POST(
      request('/api/projects/project-1/sessions', {}),
      idContext('project-1'),
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const body = (await response.json()) as { id: string; projectId: string; agentId: string };
    expect(body.projectId).toBe('project-1');
    expect(body.agentId).toBe('agent-1');

    const persisted = fixture.sessions.get(body.id);
    expect(persisted?.agentId).toBe('agent-1');
    expect(persisted?.projectId).toBe('project-1');
  });

  it('pins the version local points at, and keeps a legacy agent with no pointer unpinned (issue #612)', async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('versioned', agentRecord('versioned'));
    fixture.agents.set('legacy', agentRecord('legacy'));
    const pointer = (environment: 'local' | 'production', versionId: string, number: number) => ({
      agentId: 'versioned',
      environment,
      versionId,
      number,
      updatedAt: new Date(0),
    });
    fixture.pointers.set('versioned', [
      pointer('production', 'version-1', 1),
      pointer('local', 'version-2', 2),
    ]);
    fixture.projects.set('project-1', {
      id: 'project-1',
      workspaceId: WORKSPACE,
      name: 'P',
      instructions: null,
      defaultAgentId: 'legacy',
      visibility: 'private',
      defaultModelConnectionId: null,
      defaultModel: null,
      createdBy: 'builder-a@example.test',
      ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const start = async (agentId: string) => {
      const response = await POST(
        request('/api/projects/project-1/sessions', { agentId }),
        idContext('project-1'),
      );
      expect(response.status, await response.clone().text()).toBe(201);
      const { id } = (await response.json()) as { id: string };
      return fixture.sessions.get(id)?.agentVersionId;
    };

    expect(await start('versioned')).toBe('version-2');
    // `no_pointer` in the release model; the server keeps the legacy session and runs the row.
    expect(await start('legacy')).toBeNull();
  });

  it('starts the session with the composer-selected agent when agentId is supplied', async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('default-agent', agentRecord('default-agent'));
    fixture.agents.set('selected-agent', agentRecord('selected-agent'));
    fixture.projects.set('project-1', {
      id: 'project-1',
      workspaceId: WORKSPACE,
      name: 'P',
      instructions: null,
      defaultAgentId: 'default-agent',
      visibility: 'private',
      defaultModelConnectionId: null,
      defaultModel: null,
      createdBy: 'builder-a@example.test',
      ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await POST(
      request('/api/projects/project-1/sessions', { agentId: 'selected-agent' }),
      idContext('project-1'),
    );

    expect(response.status, await response.clone().text()).toBe(201);
    const body = (await response.json()) as { id: string; projectId: string; agentId: string };
    expect(body).toMatchObject({ projectId: 'project-1', agentId: 'selected-agent' });
    expect(fixture.sessions.get(body.id)?.agentId).toBe('selected-agent');
  });

  it('names an unresolvable composer-selected agent separately from a broken project default', async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('default-agent', agentRecord('default-agent'));
    fixture.projects.set('project-1', {
      id: 'project-1',
      workspaceId: WORKSPACE,
      name: 'P',
      instructions: null,
      defaultAgentId: 'default-agent',
      visibility: 'private',
      defaultModelConnectionId: null,
      defaultModel: null,
      createdBy: 'builder-a@example.test',
      ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await POST(
      request('/api/projects/project-1/sessions', { agentId: 'deleted-agent' }),
      idContext('project-1'),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'project_session_agent_not_found' },
    });
  });

  it('refuses to start a session when defaultAgentId is unresolvable — missing or deleted', async () => {
    const fixture = useMemoryRuntime();
    fixture.projects.set('no-default', {
      id: 'no-default',
      workspaceId: WORKSPACE,
      name: 'P',
      instructions: null,
      defaultAgentId: null,
      visibility: 'private',
      defaultModelConnectionId: null,
      defaultModel: null,
      createdBy: 'builder-a@example.test',
      ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const noDefault = await POST(
      request('/api/projects/no-default/sessions', {}),
      idContext('no-default'),
    );
    expect(noDefault.status).toBe(422);

    fixture.projects.set('ghost-agent', {
      id: 'ghost-agent',
      workspaceId: WORKSPACE,
      name: 'P',
      instructions: null,
      defaultAgentId: 'does-not-exist',
      visibility: 'private',
      defaultModelConnectionId: null,
      defaultModel: null,
      createdBy: 'builder-a@example.test',
      ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const ghostAgent = await POST(
      request('/api/projects/ghost-agent/sessions', {}),
      idContext('ghost-agent'),
    );
    expect(ghostAgent.status).toBe(422);
    expect(fixture.sessions.size).toBe(0);
  });

  it("changing the project's defaultAgentId after a session started does not rewrite that session's agent", async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('agent-1', agentRecord('agent-1'));
    fixture.agents.set('agent-2', agentRecord('agent-2'));
    fixture.projects.set('project-1', {
      id: 'project-1',
      workspaceId: WORKSPACE,
      name: 'P',
      instructions: null,
      defaultAgentId: 'agent-1',
      visibility: 'private',
      defaultModelConnectionId: null,
      defaultModel: null,
      createdBy: 'builder-a@example.test',
      ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const first = await POST(
      request('/api/projects/project-1/sessions', {}),
      idContext('project-1'),
    );
    const { id: sessionId } = (await first.json()) as { id: string };

    // The project's default agent changes; nothing in this route (or in `sessions.update`, which
    // carries no `agentId` field at all) can reach back and rewrite the already-started session.
    fixture.projects.set('project-1', {
      ...fixture.projects.get('project-1')!,
      defaultAgentId: 'agent-2',
    });
    expect(fixture.sessions.get(sessionId)?.agentId).toBe('agent-1');
  });

  it('moving a session requires authorisation on both the destination and the source project', async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('agent-1', agentRecord('agent-1'));
    fixture.projects.set('mine', {
      id: 'mine',
      workspaceId: WORKSPACE,
      name: 'Mine',
      instructions: null,
      defaultAgentId: 'agent-1',
      visibility: 'private',
      defaultModelConnectionId: null,
      defaultModel: null,
      createdBy: 'builder-a@example.test',
      ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fixture.projects.set('theirs', {
      id: 'theirs',
      workspaceId: WORKSPACE,
      name: 'Theirs',
      instructions: null,
      defaultAgentId: 'agent-1',
      visibility: 'private',
      defaultModelConnectionId: null,
      defaultModel: null,
      createdBy: 'builder-b@example.test',
      ownerPrincipalId: BUILDER_B_PRINCIPAL_ID,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fixture.sessions.set('session-in-theirs', {
      engine: null,
      agentVersionId: null,
      id: 'session-in-theirs',
      workspaceId: WORKSPACE,
      agentId: 'agent-1',
      userId: 'builder-b@example.test',
      ownerPrincipalId: BUILDER_B_PRINCIPAL_ID,
      projectId: 'theirs',
      engineSessionId: null,
      title: null,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Builder A owns "mine" (the destination) but not "theirs" (the session's current project).
    const denied = await POST(
      request('/api/projects/mine/sessions', { sessionId: 'session-in-theirs' }),
      idContext('mine'),
    );
    expect(denied.status).toBe(403);
    expect(fixture.sessions.get('session-in-theirs')?.projectId).toBe('theirs');
  });

  // Verification round 1, Finding 1 (issue #125's own Verifier attack #3): "move the session to a
  // second project and assert the earlier run's attribution still points at the first [project]".
  // `sessions.project_id` has no snapshot column to preserve that assertion once a move happens
  // (unlike `sessions.agent_id`, which simply has no update path — see the ADR), so the only way
  // to keep it true is to refuse the move outright once the session has a run.
  it("refuses to move a session that already has a run, so a run's project attribution can never be rewritten", async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('agent-1', agentRecord('agent-1'));
    fixture.projects.set('origin', {
      id: 'origin',
      workspaceId: WORKSPACE,
      name: 'Origin',
      instructions: null,
      defaultAgentId: 'agent-1',
      visibility: 'private',
      defaultModelConnectionId: null,
      defaultModel: null,
      createdBy: 'builder-a@example.test',
      ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fixture.projects.set('destination', {
      id: 'destination',
      workspaceId: WORKSPACE,
      name: 'Destination',
      instructions: null,
      defaultAgentId: 'agent-1',
      visibility: 'private',
      defaultModelConnectionId: null,
      defaultModel: null,
      createdBy: 'builder-a@example.test',
      ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fixture.sessions.set('ran-already', {
      engine: null,
      agentVersionId: null,
      id: 'ran-already',
      workspaceId: WORKSPACE,
      agentId: 'agent-1',
      userId: 'builder-a@example.test',
      ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
      projectId: 'origin',
      engineSessionId: null,
      title: null,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fixture.sessionsWithRuns.add('ran-already');

    const response = await POST(
      request('/api/projects/destination/sessions', { sessionId: 'ran-already' }),
      idContext('destination'),
    );
    expect(response.status, await response.clone().text()).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('project_session_has_runs');
    // The assertion the card's Verifier attack #3 asks for: the run's project attribution (only
    // reachable via the session it belongs to) still points at "origin".
    expect(fixture.sessions.get('ran-already')?.projectId).toBe('origin');
  });

  it('still moves a session that has no runs at all', async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('agent-1', agentRecord('agent-1'));
    fixture.projects.set('origin', {
      id: 'origin',
      workspaceId: WORKSPACE,
      name: 'Origin',
      instructions: null,
      defaultAgentId: 'agent-1',
      visibility: 'private',
      defaultModelConnectionId: null,
      defaultModel: null,
      createdBy: 'builder-a@example.test',
      ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fixture.projects.set('destination', {
      id: 'destination',
      workspaceId: WORKSPACE,
      name: 'Destination',
      instructions: null,
      defaultAgentId: 'agent-1',
      visibility: 'private',
      defaultModelConnectionId: null,
      defaultModel: null,
      createdBy: 'builder-a@example.test',
      ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fixture.sessions.set('never-run', {
      engine: null,
      agentVersionId: null,
      id: 'never-run',
      workspaceId: WORKSPACE,
      agentId: 'agent-1',
      userId: 'builder-a@example.test',
      ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
      projectId: 'origin',
      engineSessionId: null,
      title: null,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await POST(
      request('/api/projects/destination/sessions', { sessionId: 'never-run' }),
      idContext('destination'),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(fixture.sessions.get('never-run')?.projectId).toBe('destination');
  });

  // Issue #183: "Archived projects reject every new-session and new-run entry point." Both
  // branches of this route are such an entry point, so both are asserted — and both are asserted
  // to write nothing, because a refusal that arrives after the row exists is not a refusal.
  it('refuses to start a session in an archived project, and starts one again once it is restored', async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('agent-1', agentRecord('agent-1'));
    fixture.projects.set('retired', {
      id: 'retired',
      workspaceId: WORKSPACE,
      name: 'Retired',
      instructions: null,
      defaultAgentId: 'agent-1',
      visibility: 'private',
      defaultModelConnectionId: null,
      defaultModel: null,
      createdBy: 'builder-a@example.test',
      ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
      archivedAt: new Date('2026-09-13T00:00:00.000Z'),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const refused = await POST(request('/api/projects/retired/sessions', {}), idContext('retired'));
    expect(refused.status, await refused.clone().text()).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'project_archived',
    );
    expect(fixture.sessions.size).toBe(0);

    // The positive control: the refusal above was the archived state and nothing else.
    fixture.projects.set('retired', { ...fixture.projects.get('retired')!, archivedAt: null });
    const allowed = await POST(request('/api/projects/retired/sessions', {}), idContext('retired'));
    expect(allowed.status, await allowed.clone().text()).toBe(201);
    expect(fixture.sessions.size).toBe(1);
  });

  it('refuses to move a session into an archived project, while moving one OUT of it still works', async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('agent-1', agentRecord('agent-1'));
    fixture.projects.set('retired', {
      id: 'retired',
      workspaceId: WORKSPACE,
      name: 'Retired',
      instructions: null,
      defaultAgentId: 'agent-1',
      visibility: 'private',
      defaultModelConnectionId: null,
      defaultModel: null,
      createdBy: 'builder-a@example.test',
      ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
      archivedAt: new Date('2026-09-13T00:00:00.000Z'),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fixture.projects.set('live', {
      id: 'live',
      workspaceId: WORKSPACE,
      name: 'Live',
      instructions: null,
      defaultAgentId: 'agent-1',
      visibility: 'private',
      defaultModelConnectionId: null,
      defaultModel: null,
      createdBy: 'builder-a@example.test',
      ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fixture.sessions.set('stranded', {
      engine: null,
      agentVersionId: null,
      id: 'stranded',
      workspaceId: WORKSPACE,
      agentId: 'agent-1',
      userId: 'builder-a@example.test',
      ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
      projectId: 'retired',
      engineSessionId: null,
      title: null,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fixture.sessions.set('elsewhere', {
      engine: null,
      agentVersionId: null,
      id: 'elsewhere',
      workspaceId: WORKSPACE,
      agentId: 'agent-1',
      userId: 'builder-a@example.test',
      ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
      projectId: 'live',
      engineSessionId: null,
      title: null,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const intoArchived = await POST(
      request('/api/projects/retired/sessions', { sessionId: 'elsewhere' }),
      idContext('retired'),
    );
    expect(intoArchived.status, await intoArchived.clone().text()).toBe(409);
    expect(((await intoArchived.json()) as { error: { code: string } }).error.code).toBe(
      'project_archived',
    );
    expect(fixture.sessions.get('elsewhere')?.projectId).toBe('live');

    // Out of an archived project is allowed: the destination is what the gate reads, so live work
    // can leave a retired project instead of being stranded in it.
    const outOfArchived = await POST(
      request('/api/projects/live/sessions', { sessionId: 'stranded' }),
      idContext('live'),
    );
    expect(outOfArchived.status, await outOfArchived.clone().text()).toBe(200);
    expect(fixture.sessions.get('stranded')?.projectId).toBe('live');
  });

  it('starting a session in a project the caller does not own is refused before any session is written', async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('agent-1', agentRecord('agent-1'));
    fixture.projects.set('theirs', {
      id: 'theirs',
      workspaceId: WORKSPACE,
      name: 'Theirs',
      instructions: null,
      defaultAgentId: 'agent-1',
      visibility: 'private',
      defaultModelConnectionId: null,
      defaultModel: null,
      createdBy: 'builder-b@example.test',
      ownerPrincipalId: BUILDER_B_PRINCIPAL_ID,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await POST(
      request('/api/projects/theirs/sessions', {}, 'builder-a@example.test'),
      idContext('theirs'),
    );
    expect(response.status).toBe(403);
    expect(fixture.sessions.size).toBe(0);
  });
});
