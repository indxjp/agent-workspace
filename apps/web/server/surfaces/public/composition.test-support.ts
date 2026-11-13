import type { SurfaceSessionsDependencies } from './composition';
import { createInMemoryWorkspaceScopeResolver, type SessionRecord } from '@agent-workspace/core/db';
import { type SurfaceSessionRequest } from '@indx-workspace/contracts/surfaces';
import { FIXTURE_PERMISSIONS, versionRequest } from '../../agent-versions/fixtures';
import type { AgentRecord } from '../../agents/contract';
import { createInMemoryAgentStoreProvider } from '../../agents/memory-store';
import { type IdGenerator } from '../../ids';
import { createSurfaceSessionsRuntime } from './composition';
import type { ResolvedSurface, SurfaceSessionOpening, SurfaceSessionsRuntime } from './runtime';

export const WORKSPACE_ID = '66666666-6666-4666-8666-666666666666';

export const OWNER = '36377a6a-7a0b-4610-8efc-d31547dcc38a';

export const STRANGER = '9c0b0f43-5a39-4c4f-9a3f-3f8f3e4a1b2c';

export const TOKEN = `awt_live_${'a'.repeat(22)}_${'b'.repeat(43)}`;

export const EXPIRES_AT = new Date('2026-10-03T11:00:00.000Z');

export const ARCHIVED_AT = new Date('2026-10-01T00:00:00.000Z');

export interface KeyRow {
  readonly sessionId: string;
  readonly surfaceName: string;
  readonly agentId: string;
  readonly keyHash: string;
}

export interface Fixture {
  readonly runtime: SurfaceSessionsRuntime;
  readonly resolved: ResolvedSurface;
  readonly agents: Readonly<Record<'desk' | 'billing' | 'foreign' | 'unpointed', AgentRecord>>;
  readonly sessions: Map<string, SessionRecord>;
  readonly keys: Map<string, KeyRow>;
  readonly preflights: {
    owner: string;
    agentId: string;
    sessionId: string | null;
    versionId: string | null;
  }[];
  /** Mutable surface-session fixture and its version, session and resume-key adapters. */
  readonly promoted: Set<string>;
  readonly writes: string[];
  /** The agents the store reports archived (issue #1851). */
  readonly archived: Set<string>;
  refusePreflight: boolean;
  archiveOnPreflight: string | null;
  /** Whether the desk's `production` version carries `main` (no origins listed). */
  productionSurface: boolean;
  /** The process environment; empty, so the deployment workspace is `default` (`WORKSPACE_SLUG` unset). */
  env: Readonly<Record<string, string>>;
}

export async function fixture(options: { readonly ids?: IdGenerator } = {}): Promise<Fixture> {
  const agentStore = createInMemoryAgentStoreProvider();
  const workspaceAgents = agentStore.forWorkspace(WORKSPACE_ID);
  async function agent(name: string, owner: string): Promise<AgentRecord> {
    const created = await workspaceAgents.create(
      {
        name,
        instructions: '',
        modelConnectionId: null,
        model: null,
        permissions: FIXTURE_PERMISSIONS,
      },
      { principalId: owner, userId: null },
    );
    if (created.kind !== 'created') throw new Error(`the memory store creates ${name}`);
    return created.agent;
  }
  const agents = {
    desk: await agent('Front desk', OWNER),
    billing: await agent('Billing', OWNER),
    foreign: await agent('Foreign', STRANGER),
    unpointed: await agent('Unpointed', OWNER),
  };
  const pointed = new Set([agents.desk.id, agents.billing.id, agents.foreign.id]);
  const promoted = new Set<string>();
  const sessions = new Map<string, SessionRecord>();
  const keys = new Map<string, KeyRow>();
  const preflights: Fixture['preflights'] = [];
  const writes: string[] = [];
  const archived = new Set<string>();
  // Read while the runtime is built (it checks `WORKSPACE_SLUG` once), before `state` exists.
  let environment: Readonly<Record<string, string>> = {};

  const state: Fixture = {
    resolved: {
      workspaceId: WORKSPACE_ID,
      agentId: agents.desk.id,
      agentName: agents.desk.name,
      environment: 'local',
      versionId: `local-version-of-${agents.desk.id}`,
      versionNumber: 1,
      promoted: false,
      surface: {
        name: 'main',
        agent: agents.desk.name,
        parts: { agentSwitcher: { agents: ['Billing', 'Foreign', 'Unpointed'] } },
      },
    },
    agents,
    sessions,
    keys,
    preflights,
    promoted,
    writes,
    archived,
    refusePreflight: false,
    archiveOnPreflight: null,
    productionSurface: false,
    get env() {
      return environment;
    },
    set env(value) {
      environment = value;
    },
    runtime: createSurfaceSessionsRuntime({
      env: () => environment,
      scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE_ID, slug: 'default' }]),
      agentVersions: fixtureAgentVersions(() => state, pointed),
      agents: {
        forWorkspace: (workspaceId) => {
          const store = agentStore.forWorkspace(workspaceId);
          const marked = (record: AgentRecord): AgentRecord =>
            archived.has(record.id) ? { ...record, archivedAt: ARCHIVED_AT } : record;
          return {
            ...store,
            get: async (id) => {
              const found = await store.get(id);
              return found === null ? null : marked(found);
            },
            list: async () => (await store.list()).map(marked),
          };
        },
      },
      principalById: (_workspaceId, principalId) =>
        Promise.resolve({
          principalId,
          kind: 'membership',
          role: 'owner',
          label: 'Owner',
          userId: null,
          apiKeyId: null,
          actsForPrincipalId: null,
        }),
      sessions: fixtureSessions(() => state),
      surfaceSessionKeys: fixtureSurfaceSessionKeys(() => state),
      runGate: { isUsable: () => Promise.resolve(true) },
      preflight: (principal, agentRef, sessionId, versionId) => {
        preflights.push({
          owner: principal.ownerPrincipalId,
          agentId: agentRef.id,
          sessionId,
          versionId,
        });
        const archived =
          state.archiveOnPreflight === null ? undefined : sessions.get(state.archiveOnPreflight);
        if (archived !== undefined) {
          sessions.set(archived.id, { ...archived, status: 'archived' });
        }
        return Promise.resolve(
          state.refusePreflight
            ? { code: 'agent_runtime_profile_missing', message: 'no runtime profile' }
            : null,
        );
      },
      tokens: () => ({
        // As the real runtime does, mint nothing for a session that is no longer live.
        issue: (_principal, scope) =>
          Promise.resolve(
            sessions.get(scope.id)?.status === 'archived'
              ? null
              : { token: TOKEN, expiresAt: EXPIRES_AT },
          ),
      }),
      ...(options.ids === undefined ? {} : { ids: options.ids }),
    }),
  };
  return state;
}

export type Opened = Extract<SurfaceSessionOpening, { kind: 'opened' }>;

export async function openedBy(state: Fixture, request: SurfaceSessionRequest): Promise<Opened> {
  const opening = await state.runtime.open(state.resolved, request);
  if (opening.kind !== 'opened') throw new Error(`expected a session, got ${opening.kind}`);
  return opening;
}

export function resumeOf(opened: Opened): NonNullable<SurfaceSessionRequest['resume']> {
  if (opened.resumeKey === null) throw new Error('a fresh session carries a resume key');
  return { sessionId: opened.sessionId, resumeKey: opened.resumeKey };
}

export function fixtureSurfaceSessionKeys(
  state: () => Fixture,
): SurfaceSessionsDependencies['surfaceSessionKeys'] {
  return {
    forScope: () => ({
      record: (input) => {
        state().writes.push(`key ${input.sessionId}`);
        state().keys.set(input.sessionId, input);
        return Promise.resolve();
      },
      find: (sessionId) => Promise.resolve(state().keys.get(sessionId) ?? null),
    }),
  };
}

export function fixtureSessions(state: () => Fixture): SurfaceSessionsDependencies['sessions'] {
  return {
    forScope: () => ({
      ensure: (input) => {
        state().writes.push(`session ${input.id}`);
        const session: SessionRecord = {
          id: input.id,
          workspaceId: WORKSPACE_ID,
          agentId: input.agentId,
          userId: null,
          ownerPrincipalId: input.ownerPrincipalId,
          projectId: null,
          engineSessionId: null,
          engine: null,
          agentVersionId: input.agentVersionId ?? null,
          title: null,
          status: 'active',
          createdAt: EXPIRES_AT,
          updatedAt: EXPIRES_AT,
        };
        state().sessions.set(input.id, session);
        return Promise.resolve({ kind: 'created', session });
      },
      get: (id) => Promise.resolve(state().sessions.get(id) ?? null),
    }),
  };
}

export function fixtureAgentVersions(
  state: () => Fixture,
  pointed: ReadonlySet<string>,
): SurfaceSessionsDependencies['agentVersions'] {
  return {
    forScope: () => ({
      // Every version of the desk carries `main`, capped at its number of turns (issue #622).
      findById: (versionId) =>
        Promise.resolve(
          versionId.endsWith(state().agents.desk.id)
            ? {
                id: versionId,
                workspaceId: WORKSPACE_ID,
                agentId: state().agents.desk.id,
                number: versionId.startsWith('local') ? 2 : 1,
                summary: '',
                via: 'api' as const,
                body: versionRequest({
                  name: state().agents.desk.name,
                  surfaces: [
                    {
                      name: 'main',
                      agent: state().agents.desk.name,
                      limits: { turnsPerConversation: versionId.startsWith('local') ? 2 : 1 },
                    },
                  ],
                }).body,
                createdByPrincipalId: OWNER,
                createdAt: EXPIRES_AT,
              }
            : null,
        ),
      // The desk's `local` version carries `main`; `production` does only when the test says so.
      findPointedSurface: (environment, name) =>
        Promise.resolve(
          name === 'main' && (environment === 'local' || state().productionSurface)
            ? {
                agentId: state().agents.desk.id,
                versionId: `${environment}-version-of-${state().agents.desk.id}`,
                number: environment === 'local' ? 2 : 1,
                surface: { name: 'main', agent: state().agents.desk.name },
              }
            : null,
        ),
      listPointedSurfaceNames: () => Promise.resolve(['main', 'unparsed']),
      list: (agentId) =>
        Promise.resolve({
          versions: [],
          materialisedVersionId: null,
          pointers: (['local', 'production'] as const)
            .filter((environment) =>
              environment === 'local' ? pointed.has(agentId) : state().promoted.has(agentId),
            )
            .map((environment) => ({
              agentId,
              environment,
              versionId: `${environment}-version-of-${agentId}`,
              number: environment === 'local' ? 2 : 1,
              updatedAt: EXPIRES_AT,
            })),
        }),
    }),
  };
}
