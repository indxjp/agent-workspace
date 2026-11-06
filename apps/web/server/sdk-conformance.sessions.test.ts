/**
 * SDK conformance, sessions: see `sdk-conformance.test-support.ts` for what this suite pins.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectSessionMoveResponseSchema } from '@indx-workspace/contracts/projects';
import {
  PROJECT_KEY_PATTERN,
  SESSION_STATUSES,
  SessionResourceSchema,
  SessionResponseSchema,
  TRANSCRIPT_SUBPATH_MAX_LENGTH,
  TRANSCRIPT_SUBPATH_PATTERN,
  TranscriptResponseSchema,
  TranscriptSubkeysResponseSchema,
} from '@indx-workspace/contracts/sessions';
import {
  type AgentRepository,
  type AuditEventRepository,
  type ProjectFileRepository,
  type ProjectMcpServerRepository,
  type ProjectRecord,
  type ProjectRepository,
  type SessionRecord,
  type SessionRepository,
} from '@agent-workspace/core/db';
import { POST as postProjectSession } from '../app/api/projects/[id]/sessions/route';
import { createMemoryDirectory } from './rbac/memory-directory';
import { Principal } from './rbac/principal';
import { listTranscriptSubkeys, loadTranscript, serializeSession } from './sessions/api';
import { InMemoryTranscriptStore } from './sessions/memory-store';
import {
  MAX_SUBPATH_LENGTH as SERVER_MAX_SUBPATH_LENGTH,
  PROJECT_KEY_PATTERN as SERVER_PROJECT_KEY_PATTERN,
  SUBPATH_PATTERN as SERVER_SUBPATH_PATTERN,
} from './sessions/transcript';
import { clearApplicationContext } from './application-context';
import { installTestDomains } from './application-context-fixtures';

const SESSIONS_WORKSPACE = '44444444-4444-4444-8444-444444444444';

const SESSIONS_AGENT = '11111111-1111-4111-8111-111111111111';

const SESSIONS_PROJECT = '66666666-6666-4666-8666-666666666666';

const SESSIONS_PRINCIPAL = 'a7367c68-ea61-4b03-bbf1-3cfd0fcac445';

const SESSIONS_ROW = '55555555-5555-4555-8555-555555555555';

const SESSIONS_PROVIDER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const sessionRow: SessionRecord = {
  id: SESSIONS_ROW,
  workspaceId: SESSIONS_WORKSPACE,
  agentId: SESSIONS_AGENT,
  userId: null,
  ownerPrincipalId: SESSIONS_PRINCIPAL,
  projectId: null,
  engineSessionId: null,
  engine: null,
  agentVersionId: null,
  title: null,
  status: 'active',
  createdAt: new Date('2026-09-21T10:00:00.000Z'),
  updatedAt: new Date('2026-09-21T10:00:00.000Z'),
};

describe('sessions', () => {
  afterEach(() => {
    clearApplicationContext();
  });

  it('serialises a fresh session row and a resumable, titled one into the published shape', () => {
    expect(SessionResourceSchema.safeParse(serializeSession(sessionRow)).success).toBe(true);
    const resumable = serializeSession({
      ...sessionRow,
      userId: '77777777-7777-4777-8777-777777777777',
      projectId: SESSIONS_PROJECT,
      engineSessionId: SESSIONS_PROVIDER_ID,
      engine: 'claude-agent-sdk' as const,
      title: 'Incident 42',
      updatedAt: new Date('2026-09-21T10:05:00.000Z'),
    });
    const parsed = SessionResourceSchema.parse(resumable);
    expect(parsed.resumable).toBe(true);
    expect(parsed.updatedAt).toBe('2026-09-21T10:05:00.000Z');
    expect(SessionResponseSchema.safeParse({ session: resumable }).success).toBe(true);
    expect(serializeSession(null)).toBeNull();
  });

  it('restates the session statuses and the transcript key grammar the server enforces', () => {
    // The server keeps no status tuple (`SessionRecord.status` is a type union), so the
    // vocabulary is proven through the serializer: both of its states satisfy the contract.
    for (const status of SESSION_STATUSES) {
      expect(
        SessionResourceSchema.safeParse(serializeSession({ ...sessionRow, status })).success,
      ).toBe(true);
    }
    expect(SERVER_PROJECT_KEY_PATTERN.source).toBe(PROJECT_KEY_PATTERN.source);
    expect(SERVER_SUBPATH_PATTERN.source).toBe(TRANSCRIPT_SUBPATH_PATTERN.source);
    expect(SERVER_MAX_SUBPATH_LENGTH).toBe(TRANSCRIPT_SUBPATH_MAX_LENGTH);
  });
});

describe('sessions', () => {
  afterEach(() => {
    clearApplicationContext();
  });

  it('renders the transcript and subkeys routes into the published envelopes', async () => {
    const store = new InMemoryTranscriptStore();
    installTestDomains({
      sessions: {
        authenticate: () =>
          Promise.resolve({
            kind: 'user',
            principalId: SESSIONS_PRINCIPAL,
            ownerPrincipalId: SESSIONS_PRINCIPAL,
            userId: null,
            workspaceId: SESSIONS_WORKSPACE,
            role: 'builder',
          }),
        canAccessSession: () => Promise.resolve(true),
        store,
      },
    });
    const main = { projectKey: SESSIONS_WORKSPACE, sessionId: SESSIONS_PROVIDER_ID };
    await store.append(main, [
      { type: 'user', uuid: 'u-1', timestamp: '2026-09-21T10:00:00.000Z', message: {} },
      { type: 'assistant', uuid: 'a-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]);
    await store.append({ ...main, subpath: 'subagents/agent-1a2b' }, [{ type: 'user' }]);
    const base = `https://control.example/api/sessions/${SESSIONS_PROVIDER_ID}`;
    const transcript = await loadTranscript(
      new Request(`${base}/transcript?projectKey=${SESSIONS_WORKSPACE}`),
      SESSIONS_PROVIDER_ID,
    );
    expect(transcript.status).toBe(200);
    expect(TranscriptResponseSchema.parse(await transcript.json()).entries).toHaveLength(2);
    const subagent = await loadTranscript(
      new Request(
        `${base}/transcript?projectKey=${SESSIONS_WORKSPACE}&subpath=subagents%2Fagent-1a2b`,
      ),
      SESSIONS_PROVIDER_ID,
    );
    expect(TranscriptResponseSchema.parse(await subagent.json()).entries).toEqual([
      { type: 'user' },
    ]);
    const subkeys = await listTranscriptSubkeys(
      new Request(`${base}/subkeys?projectKey=${SESSIONS_WORKSPACE}`),
      SESSIONS_PROVIDER_ID,
    );
    expect(subkeys.status).toBe(200);
    expect(TranscriptSubkeysResponseSchema.parse(await subkeys.json()).subkeys).toEqual([
      'subagents/agent-1a2b',
    ]);
  });
});

describe('sessions', () => {
  afterEach(() => {
    clearApplicationContext();
  });

  it('renders the same published envelopes when the request omits projectKey (issue #235, S-21)', async () => {
    const store = new InMemoryTranscriptStore();
    installTestDomains({
      sessions: {
        authenticate: () =>
          Promise.resolve({
            kind: 'user',
            principalId: SESSIONS_PRINCIPAL,
            ownerPrincipalId: SESSIONS_PRINCIPAL,
            userId: null,
            workspaceId: SESSIONS_WORKSPACE,
            role: 'builder',
          }),
        canAccessSession: () => Promise.resolve(true),
        store,
      },
    });
    const main = { projectKey: SESSIONS_WORKSPACE, sessionId: SESSIONS_PROVIDER_ID };
    await store.append(main, [{ type: 'user', uuid: 'u-1' }]);
    const base = `https://control.example/api/sessions/${SESSIONS_PROVIDER_ID}`;
    const transcript = await loadTranscript(
      new Request(`${base}/transcript`),
      SESSIONS_PROVIDER_ID,
    );
    expect(transcript.status).toBe(200);
    expect(TranscriptResponseSchema.parse(await transcript.json())).toEqual({
      entries: [{ type: 'user', uuid: 'u-1' }],
    });
    const subkeys = await listTranscriptSubkeys(
      new Request(`${base}/subkeys`),
      SESSIONS_PROVIDER_ID,
    );
    expect(subkeys.status).toBe(200);
    expect(TranscriptSubkeysResponseSchema.parse(await subkeys.json())).toEqual({ subkeys: [] });
  });
});

function destinationProject(): ProjectRecord {
  return {
    id: SESSIONS_PROJECT,
    workspaceId: SESSIONS_WORKSPACE,
    name: 'Ops',
    instructions: null,
    defaultAgentId: SESSIONS_AGENT,
    defaultModelConnectionId: null,
    defaultModel: null,
    visibility: 'private',
    createdBy: null,
    ownerPrincipalId: SESSIONS_PRINCIPAL,
    archivedAt: null,
    createdAt: new Date('2026-09-21T10:00:00.000Z'),
    updatedAt: new Date('2026-09-21T10:00:00.000Z'),
  };
}

/** Repositories a session move touches; every method it does not reach rejects. */
function sessionMoveRepositories(destination: ProjectRecord) {
  const unused = () => Promise.reject(new Error('not reached by a session move'));
  const projects: ProjectRepository = {
    list: unused,
    get: (id) => Promise.resolve(id === destination.id ? destination : null),
    create: unused,
    createWithAssociations: unused,
    update: unused,
    updateWithAssociations: unused,
    moveSession: () => Promise.resolve({ kind: 'moved' }),
    archive: unused,
    restore: unused,
  };
  const sessions: SessionRepository = {
    ensure: unused,
    get: (id) => Promise.resolve(id === sessionRow.id ? sessionRow : null),
    getByEngineSessionId: unused,
    list: unused,
    update: unused,
    archive: unused,
    restore: unused,
    discardIfUnused: () => Promise.resolve(false),
  };
  const files: ProjectFileRepository = { list: unused, add: unused, remove: unused };
  const mcpServers: ProjectMcpServerRepository = { list: unused, add: unused, remove: unused };
  const audit: AuditEventRepository = {
    write: () => Promise.resolve(),
    count: unused,
    list: unused,
  };
  const agents: AgentRepository = {
    list: unused,
    get: unused,
    create: unused,
    createWithAssignments: unused,
    update: unused,
    delete: unused,
    replacePolicy: unused,
    listArchiveCandidates: unused,
    archive: unused,
    restore: unused,
  };
  return { projects, files, mcpServers, audit, agents, sessions, agentVersions: { list: unused } };
}

/** Installs the project domain over `repositories`, acting as a Builder API key. */
function installSessionMoveDomains(repositories: ReturnType<typeof sessionMoveRepositories>): void {
  const principal = Principal.fromApiKey({
    principalId: SESSIONS_PRINCIPAL,
    apiKeyId: '9a5f38dd-dc4f-4b8d-8ccb-7e4578489b01',
    workspaceId: SESSIONS_WORKSPACE,
    role: 'builder',
    label: 'Builder key',
  });
  installTestDomains({
    projects: {
      resolveActor: () =>
        Promise.resolve({
          kind: 'workspace',
          workspaceId: SESSIONS_WORKSPACE,
          principalId: SESSIONS_PRINCIPAL,
          ownerPrincipalId: SESSIONS_PRINCIPAL,
          userId: null,
          userLabel: 'Builder key',
        }),
      forWorkspace: () => Promise.resolve(repositories),
    },
  });
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory({ users: [] }),
      identify: () => Promise.resolve(principal),
    },
  });
}

describe('sessions', () => {
  afterEach(() => {
    clearApplicationContext();
  });

  it('renders a moved session from POST /api/projects/:id/sessions into the published shape', async () => {
    installSessionMoveDomains(sessionMoveRepositories(destinationProject()));
    const response = await postProjectSession(
      new Request(`https://control.example/api/projects/${SESSIONS_PROJECT}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSIONS_ROW }),
      }),
      { params: Promise.resolve({ id: SESSIONS_PROJECT }) },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(ProjectSessionMoveResponseSchema.parse(await response.json())).toEqual({
      projectId: SESSIONS_PROJECT,
      sessionId: SESSIONS_ROW,
    });
  });
});
