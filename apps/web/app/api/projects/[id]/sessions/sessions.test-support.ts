import type {
  AgentRecord,
  AgentVersionPointerRecord,
  EnsureSessionInput,
  EnsureSessionOutcome,
  ProjectRecord,
  SessionRecord,
} from '@agent-workspace/core/db';
import { installTestDomains } from '../../../../../server/application-context-fixtures';
import type {
  ProjectRows,
  ProjectSessionRows,
  ProjectsWorkspaceStore,
} from '../../../../../server/projects/store';
import { createMemoryDirectory } from '../../../../../server/rbac/memory-directory';
import { Principal } from '../../../../../server/rbac/principal';

const WORKSPACE = '55555555-5555-4555-8555-555555555555';
const WORKSPACE_HEADER = 'x-test-workspace';
const ACTOR_HEADER = 'x-test-actor';
const BUILDER_A_PRINCIPAL_ID = 'a7367c68-ea61-4b03-bbf1-3cfd0fcac445';
export const BUILDER_B_PRINCIPAL_ID = 'bf655e39-5833-4ea7-a8d9-28337906dc54';

function principalIdFor(actor: string): string {
  return actor === 'builder-a@example.test' ? BUILDER_A_PRINCIPAL_ID : BUILDER_B_PRINCIPAL_ID;
}

export function agentRecord(id: string): AgentRecord {
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
export function useMemoryRuntime(): Fixture {
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

  const projects = projectsStore(fixture);
  const files: ProjectsWorkspaceStore['files'] = {
    list: () => Promise.resolve([]),
  };
  const mcpServers: ProjectsWorkspaceStore['mcpServers'] = {
    list: () => Promise.resolve([]),
  };
  const audit: ProjectsWorkspaceStore['audit'] = {
    write: () => Promise.resolve(),
  };
  const agents: ProjectsWorkspaceStore['agents'] = {
    get: (id) => Promise.resolve(fixture.agents.get(id) ?? null),
  };
  const sessions = sessionsStore(fixture);

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

  installSessionRbac();

  return fixture;
}

export function request(url: string, body: unknown, actor = 'builder-a@example.test'): Request {
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

export function idContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

export function projectRecord(
  input: Pick<ProjectRecord, 'id'> & Partial<ProjectRecord>,
): ProjectRecord {
  return {
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
    ...input,
  };
}

export function sessionRecord(
  input: Pick<SessionRecord, 'id' | 'projectId'> & Partial<SessionRecord>,
): SessionRecord {
  return {
    engine: null,
    agentVersionId: null,
    workspaceId: WORKSPACE,
    agentId: 'agent-1',
    userId: 'builder-a@example.test',
    ownerPrincipalId: BUILDER_A_PRINCIPAL_ID,
    engineSessionId: null,
    title: null,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...input,
  };
}

export function existingProject(fixture: Fixture, id: string): ProjectRecord {
  const project = fixture.projects.get(id);
  if (project === undefined) throw new Error(`fixture project ${id} is missing`);
  return project;
}

function projectsStore(fixture: Fixture): ProjectRows {
  return {
    createWithAssociations: () => Promise.reject(new Error('unused')),
    updateWithAssociations: () => Promise.reject(new Error('unused')),
    archive: () => Promise.reject(new Error('unused')),
    restore: () => Promise.reject(new Error('unused')),
    list: () => Promise.resolve([...fixture.projects.values()]),
    get: (id) => Promise.resolve(fixture.projects.get(id) ?? null),
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
  };
}
function sessionsStore(fixture: Fixture): ProjectSessionRows {
  let sessionSeq = 0;
  return {
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
  };
}
function installSessionRbac() {
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
}
