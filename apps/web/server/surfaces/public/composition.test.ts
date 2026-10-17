/**
 * The decisions of {@link createSurfaceSessionsRuntime}'s `open` (issue #538, C18, SD8), over
 * in-memory fakes of each dependency: which agent a bootstrap may talk to, which session a key
 * resumes, and that every refusal writes nothing. `surface-sessions.integration.test.ts` proves
 * the same against PostgreSQL through `register()`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createInMemoryWorkspaceScopeResolver, type SessionRecord } from '@agent-workspace/core/db';
import {
  SURFACE_ALLOWED_ORIGINS_MAX,
  type SurfaceDefinition,
  type SurfaceSessionRequest,
} from '@indx-workspace/contracts/surfaces';

import { FIXTURE_PERMISSIONS, versionRequest } from '../../agent-versions/fixtures';
import type { AgentRecord } from '../../agents/contract';
import { createInMemoryAgentStoreProvider } from '../../agents/memory-store';
import { hashApiKeySecret } from '../../rbac/api-key';
import {
  createSurfaceSessionsRuntime,
  pickSurfaceVersion,
  withDeploymentOrigin,
} from './composition';
import { mayOpenSession } from './conditions';
import { DEFAULT_TURNS_PER_CONVERSATION, turnsPerConversation } from './limits';
import type { ResolvedSurface, SurfaceSessionOpening, SurfaceSessionsRuntime } from './runtime';

const WORKSPACE_ID = '66666666-6666-4666-8666-666666666666';
const OWNER = '36377a6a-7a0b-4610-8efc-d31547dcc38a';
const STRANGER = '9c0b0f43-5a39-4c4f-9a3f-3f8f3e4a1b2c';
const TOKEN = `awt_live_${'a'.repeat(22)}_${'b'.repeat(43)}`;
const EXPIRES_AT = new Date('2026-10-03T11:00:00.000Z');

interface KeyRow {
  readonly sessionId: string;
  readonly surfaceName: string;
  readonly agentId: string;
  readonly keyHash: string;
}

interface Fixture {
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
  /** The agents with a `production` pointer, as well as `local` (issue #612). */
  readonly promoted: Set<string>;
  readonly writes: string[];
  refusePreflight: boolean;
  archiveOnPreflight: string | null;
  /** Whether the desk's `production` version carries `main` (no origins listed). */
  productionSurface: boolean;
  /** The process environment; empty, so the deployment workspace is `default` (`WORKSPACE_SLUG` unset). */
  env: Readonly<Record<string, string>>;
}

async function fixture(): Promise<Fixture> {
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
    refusePreflight: false,
    archiveOnPreflight: null,
    productionSurface: false,
    env: {},
    runtime: createSurfaceSessionsRuntime({
      env: () => state.env,
      scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE_ID, slug: 'default' }]),
      agentVersions: {
        forScope: () => ({
          // Every version of the desk carries `main`, capped at its number of turns (issue #622).
          findById: (versionId) =>
            Promise.resolve(
              versionId.endsWith(agents.desk.id)
                ? {
                    id: versionId,
                    workspaceId: WORKSPACE_ID,
                    agentId: agents.desk.id,
                    number: versionId.startsWith('local') ? 2 : 1,
                    summary: '',
                    via: 'api' as const,
                    body: versionRequest({
                      name: agents.desk.name,
                      surfaces: [
                        {
                          name: 'main',
                          agent: agents.desk.name,
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
              name === 'main' && (environment === 'local' || state.productionSurface)
                ? {
                    agentId: agents.desk.id,
                    versionId: `${environment}-version-of-${agents.desk.id}`,
                    number: environment === 'local' ? 2 : 1,
                    surface: { name: 'main', agent: agents.desk.name },
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
                  environment === 'local' ? pointed.has(agentId) : promoted.has(agentId),
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
      },
      agents: agentStore,
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
      sessions: {
        forScope: () => ({
          ensure: (input) => {
            writes.push(`session ${input.id}`);
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
            sessions.set(input.id, session);
            return Promise.resolve({ kind: 'created', session });
          },
          get: (id) => Promise.resolve(sessions.get(id) ?? null),
        }),
      },
      surfaceSessionKeys: {
        forScope: () => ({
          record: (input) => {
            writes.push(`key ${input.sessionId}`);
            keys.set(input.sessionId, input);
            return Promise.resolve();
          },
          find: (sessionId) => Promise.resolve(keys.get(sessionId) ?? null),
        }),
      },
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
    }),
  };
  return state;
}

type Opened = Extract<SurfaceSessionOpening, { kind: 'opened' }>;

async function openedBy(state: Fixture, request: SurfaceSessionRequest): Promise<Opened> {
  const opening = await state.runtime.open(state.resolved, request);
  if (opening.kind !== 'opened') throw new Error(`expected a session, got ${opening.kind}`);
  return opening;
}

function resumeOf(opened: Opened): NonNullable<SurfaceSessionRequest['resume']> {
  if (opened.resumeKey === null) throw new Error('a fresh session carries a resume key');
  return { sessionId: opened.sessionId, resumeKey: opened.resumeKey };
}

describe('createSurfaceSessionsRuntime().open (issue #538)', () => {
  let state: Fixture;
  beforeEach(async () => {
    state = await fixture();
  });

  it('opens a session of the surface agent and records only the digest of its resume key', async () => {
    const opened = await openedBy(state, {});
    expect(opened.agentId).toBe(state.agents.desk.id);
    expect(opened.resumeKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const row = state.keys.get(opened.sessionId);
    expect(row).toEqual({
      sessionId: opened.sessionId,
      surfaceName: 'main',
      agentId: state.agents.desk.id,
      keyHash: await hashApiKeySecret(resumeOf(opened).resumeKey),
    });
    expect(row?.keyHash).not.toBe(opened.resumeKey);
    // Issue #612: the conversation pins the version `local` points at when it starts.
    expect(state.sessions.get(opened.sessionId)?.agentVersionId).toBe(
      `local-version-of-${state.agents.desk.id}`,
    );
  });

  it('opens an offered agent of the same owner as that owner, after its own preflight', async () => {
    const opened = await openedBy(state, { agent: 'Billing' });
    expect(opened.agentId).toBe(state.agents.billing.id);
    expect(state.preflights).toEqual([
      {
        owner: OWNER,
        agentId: state.agents.billing.id,
        sessionId: null,
        versionId: `local-version-of-${state.agents.billing.id}`,
      },
    ]);
    expect(state.sessions.get(opened.sessionId)?.agentId).toBe(state.agents.billing.id);
  });

  it.each([
    ['not listed', 'Somebody else'],
    ['listed but owned by another principal', 'Foreign'],
    ['listed but with no local pointer', 'Unpointed'],
  ])('refuses an agent %s with agent-not-offered, writing nothing', async (_label, agent) => {
    await expect(state.runtime.open(state.resolved, { agent })).resolves.toEqual({
      kind: 'agent-not-offered',
    });
    expect(state.preflights).toEqual([]);
    expect(state.writes).toEqual([]);
  });

  it('pins and preflights the version the surface resolved to (#612)', async () => {
    state.promoted.add(state.agents.desk.id);
    const production = `production-version-of-${state.agents.desk.id}`;
    const opened = await state.runtime.open(
      { ...state.resolved, environment: 'production', versionId: production, promoted: true },
      {},
    );
    if (opened.kind !== 'opened') throw new Error(`expected a session, got ${opened.kind}`);
    expect(state.sessions.get(opened.sessionId)?.agentVersionId).toBe(production);
    expect(state.preflights.at(-1)).toMatchObject({ sessionId: null, versionId: production });

    // The try page's session pins the local working draft it was resolved to.
    const tried = await openedBy(state, { environment: 'local' });
    expect(state.sessions.get(tried.sessionId)?.agentVersionId).toBe(
      `local-version-of-${state.agents.desk.id}`,
    );
  });

  it('pins the resolved version even when a promote lands before the session opens (#622)', async () => {
    // Resolved while `local` served the public; promoted before `open`: no second pick.
    state.promoted.add(state.agents.desk.id);
    const opened = await openedBy(state, {});
    expect(state.sessions.get(opened.sessionId)?.agentVersionId).toBe(state.resolved.versionId);
  });

  it('picks each offered agent’s environment by the same rule (#612)', async () => {
    state.promoted.add(state.agents.desk.id);
    const billing = await openedBy(state, { agent: 'Billing' });
    expect(state.sessions.get(billing.sessionId)?.agentVersionId).toBe(
      `local-version-of-${state.agents.billing.id}`,
    );
    state.promoted.add(state.agents.billing.id);
    const promoted = await openedBy(state, { agent: 'Billing' });
    expect(state.sessions.get(promoted.sessionId)?.agentVersionId).toBe(
      `production-version-of-${state.agents.billing.id}`,
    );
  });

  it('refuses an agent that is in the workspace but not offered', async () => {
    const resolved = { ...state.resolved, surface: { name: 'main', agent: 'Front desk' } };
    await expect(state.runtime.open(resolved, { agent: 'Billing' })).resolves.toEqual({
      kind: 'agent-not-offered',
    });
  });

  it('resumes the same session with a fresh token, no new key and nothing written', async () => {
    const first = await openedBy(state, {});
    state.writes.length = 0;
    const resumed = await openedBy(state, { resume: resumeOf(first) });
    expect(resumed).toEqual({
      kind: 'opened',
      sessionId: first.sessionId,
      agentId: state.agents.desk.id,
      token: TOKEN,
      expiresAt: EXPIRES_AT,
      resumeKey: null,
    });
    expect(state.writes).toEqual([]);
    expect(state.preflights.at(-1)?.sessionId).toBe(first.sessionId);
  });

  it('switches A → B → A and resumes A with A key; B key never resumes A', async () => {
    const deskSession = await openedBy(state, {});
    const billingSession = await openedBy(state, { agent: 'Billing' });
    const back = await openedBy(state, { resume: resumeOf(deskSession) });
    expect(back.sessionId).toBe(deskSession.sessionId);
    expect(back.agentId).toBe(state.agents.desk.id);

    const crossed = {
      sessionId: deskSession.sessionId,
      resumeKey: resumeOf(billingSession).resumeKey,
    };
    await expect(state.runtime.open(state.resolved, { resume: crossed })).resolves.toEqual({
      kind: 'not-resumable',
    });
    // B's own key, presented as the surface agent rather than B, resumes nothing either.
    await expect(
      state.runtime.open(state.resolved, { resume: resumeOf(billingSession) }),
    ).resolves.toEqual({ kind: 'not-resumable' });
    await expect(
      openedBy(state, { agent: 'Billing', resume: resumeOf(billingSession) }),
    ).resolves.toMatchObject({ sessionId: billingSession.sessionId });
  });

  it.each<[string, (state: Fixture, opened: Opened) => SurfaceSessionRequest]>([
    [
      'a wrong key',
      (_s, opened) => ({ resume: { ...resumeOf(opened), resumeKey: 'x'.repeat(43) } }),
    ],
    [
      'an unknown session',
      (_s, opened) => ({ resume: { ...resumeOf(opened), sessionId: crypto.randomUUID() } }),
    ],
    [
      'another surface key',
      (s, opened) => {
        const row = s.keys.get(opened.sessionId);
        if (row !== undefined) s.keys.set(opened.sessionId, { ...row, surfaceName: 'other' });
        return { resume: resumeOf(opened) };
      },
    ],
    [
      'an archived session',
      (s, opened) => {
        const session = s.sessions.get(opened.sessionId);
        if (session !== undefined)
          s.sessions.set(opened.sessionId, { ...session, status: 'archived' });
        return { resume: resumeOf(opened) };
      },
    ],
    [
      'a session whose owner changed',
      (s, opened) => {
        const session = s.sessions.get(opened.sessionId);
        if (session !== undefined) {
          s.sessions.set(opened.sessionId, { ...session, ownerPrincipalId: STRANGER });
        }
        return { resume: resumeOf(opened) };
      },
    ],
  ])(
    'refuses %s with not-resumable, before preflight and writing nothing',
    async (_label, build) => {
      const opened = await openedBy(state, {});
      const request = build(state, opened);
      state.writes.length = 0;
      state.preflights.length = 0;
      await expect(state.runtime.open(state.resolved, request)).resolves.toEqual({
        kind: 'not-resumable',
      });
      expect(state.preflights).toEqual([]);
      expect(state.writes).toEqual([]);
    },
  );

  it('refuses a resume whose session is archived after the resume check with not-resumable (#602 review)', async () => {
    const opened = await openedBy(state, {});
    // The preflight runs between `isResumable` and `tokens.issue`; archiving there is the race.
    state.archiveOnPreflight = opened.sessionId;
    await expect(state.runtime.open(state.resolved, { resume: resumeOf(opened) })).resolves.toEqual(
      { kind: 'not-resumable' },
    );
  });

  it('refuses a resume the preflight refuses, writing nothing', async () => {
    const opened = await openedBy(state, {});
    state.writes.length = 0;
    state.refusePreflight = true;
    await expect(state.runtime.open(state.resolved, { resume: resumeOf(opened) })).resolves.toEqual(
      {
        kind: 'refused',
        code: 'agent_runtime_profile_missing',
        message: 'no runtime profile',
      },
    );
    expect(state.writes).toEqual([]);
  });
});

describe('createSurfaceSessionsRuntime().checkModel (issue #661)', () => {
  let state: Fixture;
  beforeEach(async () => {
    state = await fixture();
  });

  it("runs a new session's preflight for the surface's agent at its version, writing nothing", async () => {
    await expect(state.runtime.checkModel(state.resolved)).resolves.toBeNull();
    expect(state.preflights).toEqual([
      {
        owner: OWNER,
        agentId: state.agents.desk.id,
        sessionId: null,
        versionId: state.resolved.versionId,
      },
    ]);
    state.refusePreflight = true;
    await expect(state.runtime.checkModel(state.resolved)).resolves.toEqual({
      code: 'agent_runtime_profile_missing',
      message: 'no runtime profile',
    });
    // No session, no key, no token.
    expect(state.writes).toEqual([]);
    expect(state.sessions.size).toBe(0);
  });

  it('answers null for an agent that is gone, without a preflight', async () => {
    await expect(
      state.runtime.checkModel({ ...state.resolved, agentId: crypto.randomUUID() }),
    ).resolves.toBeNull();
    expect(state.preflights).toEqual([]);
  });
});

describe('createSurfaceSessionsRuntime().visitorSurface (issue #622)', () => {
  let state: Fixture;
  beforeEach(async () => {
    state = await fixture();
  });

  it('reads the surface of the version the session pinned, not the one served now', async () => {
    const opened = await openedBy(state, {});
    // Nothing serves `main` any more, and the session still keeps its pinned limits.
    await expect(state.runtime.visitorSurface(WORKSPACE_ID, opened.sessionId)).resolves.toEqual({
      surface: { name: 'main', agent: 'Front desk', limits: { turnsPerConversation: 2 } },
    });
  });

  it('adds the deployment frontend origin to the pinned surface (ADR-0128)', async () => {
    state.env = { AW_FRONTEND_ORIGIN: 'https://agents-web.vercel.app' };
    const opened = await openedBy(state, {});
    await expect(state.runtime.visitorSurface(WORKSPACE_ID, opened.sessionId)).resolves.toEqual({
      surface: {
        name: 'main',
        agent: 'Front desk',
        limits: { turnsPerConversation: 2 },
        allowedOrigins: ['https://agents-web.vercel.app'],
      },
    });
  });

  it('reads the served surface for a switcher session, whose version carries none', async () => {
    const opened = await openedBy(state, { agent: 'Billing' });
    await expect(state.runtime.visitorSurface(WORKSPACE_ID, opened.sessionId)).resolves.toEqual({
      surface: { name: 'main', agent: 'Front desk' },
    });
  });

  it('answers null for a session the bootstrap did not open', async () => {
    await expect(
      state.runtime.visitorSurface(WORKSPACE_ID, crypto.randomUUID()),
    ).resolves.toBeNull();
  });
});

describe('createSurfaceSessionsRuntime().servedSurfaces (issue #680)', () => {
  let state: Fixture;
  beforeEach(async () => {
    state = await fixture();
    state.env = { BOOTSTRAP_ADMIN: 'owner@example.com', BOOTSTRAP_ADMIN_PASSWORD: 'x'.repeat(12) };
  });

  it('lists the surfaces served to the public, and drops a name that resolves to none', async () => {
    await expect(state.runtime.servedSurfaces()).resolves.toEqual([
      { name: 'main', agent: 'Front desk', servedFrom: 'local' },
    ]);
  });

  it('drops a surface the promoted agent production version no longer carries', async () => {
    state.promoted.add(state.agents.desk.id);
    await expect(state.runtime.servedSurfaces()).resolves.toEqual([]);
  });

  it('serves the WORKSPACE_SLUG workspace with no bootstrap credential set (issue #1168)', async () => {
    state.env = { WORKSPACE_SLUG: 'default' };
    await expect(state.runtime.servedSurfaces()).resolves.toEqual([
      { name: 'main', agent: 'Front desk', servedFrom: 'local' },
    ]);
    await expect(state.runtime.resolve('main', 'public')).resolves.not.toBeNull();
  });

  it('serves nothing for a workspace the deployment does not have', async () => {
    state.env = { WORKSPACE_SLUG: 'other-workspace' };
    await expect(state.runtime.servedSurfaces()).resolves.toEqual([]);
    await expect(state.runtime.resolve('main', 'public')).resolves.toBeNull();
  });

  it('serves nothing when WORKSPACE_SLUG is not a usable slug', async () => {
    state.env = { WORKSPACE_SLUG: 'Bad Slug' };
    await expect(state.runtime.servedSurfaces()).resolves.toEqual([]);
    await expect(state.runtime.resolve('main', 'public')).resolves.toBeNull();
  });

  describe('the deployment frontend origin (ADR-0128)', () => {
    const withEnv = (origin: string | undefined) => {
      state.env = {
        BOOTSTRAP_ADMIN: 'owner@example.com',
        BOOTSTRAP_ADMIN_PASSWORD: 'x'.repeat(12),
        ...(origin === undefined ? {} : { AW_FRONTEND_ORIGIN: origin }),
      };
    };

    const promote = () => {
      state.productionSurface = true;
      state.promoted.add(state.agents.desk.id);
    };

    it('adds it to a production surface that lists none, and leaves a surface alone when it is unset', async () => {
      promote();
      withEnv(undefined);
      await expect(state.runtime.servedSurfaces()).resolves.toEqual([
        { name: 'main', agent: 'Front desk', servedFrom: 'production' },
      ]);
      withEnv('https://agents-web.vercel.app');
      await expect(state.runtime.servedSurfaces()).resolves.toEqual([
        {
          name: 'main',
          agent: 'Front desk',
          servedFrom: 'production',
          allowedOrigins: ['https://agents-web.vercel.app'],
        },
      ]);
    });

    it('never widens a draft served from local', async () => {
      withEnv('https://agents-web.vercel.app');
      await expect(state.runtime.servedSurfaces()).resolves.toEqual([
        { name: 'main', agent: 'Front desk', servedFrom: 'local' },
      ]);
    });

    it.each([
      ['plain http', 'http://agents-web.vercel.app'],
      ['http on loopback', 'http://localhost:3000'],
      ['a wildcard', '*'],
      ['a wildcard host', 'https://*.vercel.app'],
      ['a path', 'https://agents-web.vercel.app/app'],
      ['garbage', 'not a url'],
    ])('ignores %s with one warning', async (_name, value) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      promote();
      withEnv(value);
      await expect(state.runtime.servedSurfaces()).resolves.toEqual([
        { name: 'main', agent: 'Front desk', servedFrom: 'production' },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('AW_FRONTEND_ORIGIN');
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(value);
      warn.mockRestore();
    });
  });
});

describe('withDeploymentOrigin (ADR-0128, ADR-0129)', () => {
  const FRONTEND = 'https://acme-ai-web.team.workers.dev';
  const BARE: SurfaceDefinition = { name: 'main', agent: 'Front desk' };
  const withOrigin = { AW_FRONTEND_ORIGIN: FRONTEND };

  it('adds exactly the origin to a surface that lists none, and extends a list without repeating', () => {
    expect(withDeploymentOrigin(BARE, 'production', withOrigin).allowedOrigins).toEqual([FRONTEND]);
    const listed = { ...BARE, allowedOrigins: ['https://shop.example.com'] };
    expect(withDeploymentOrigin(listed, 'production', withOrigin).allowedOrigins).toEqual([
      'https://shop.example.com',
      FRONTEND,
    ]);
    const already = { ...BARE, allowedOrigins: [FRONTEND] };
    expect(withDeploymentOrigin(already, 'production', withOrigin)).toBe(already);
  });

  it('never widens a draft served from local', () => {
    expect(withDeploymentOrigin(BARE, 'local', withOrigin)).toBe(BARE);
  });

  it.each([
    ['unset', undefined],
    ['blank', '  '],
    ['a wildcard', '*'],
    ['a wildcard host', 'https://*.workers.dev'],
    ['http', 'http://acme-ai-web.team.workers.dev'],
    ['http on loopback', 'http://localhost:5173'],
    ['a path', `${FRONTEND}/chat`],
    ['a trailing slash', `${FRONTEND}/`],
    ['two origins', `${FRONTEND},https://other.example.com`],
    ['not a URL', 'acme-ai-web'],
  ])('adds nothing when the value is %s', (_label, value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(withDeploymentOrigin(BARE, 'production', { AW_FRONTEND_ORIGIN: value })).toBe(BARE);
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves a full list as it is rather than refusing the surface', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const full = {
        ...BARE,
        allowedOrigins: Array.from(
          { length: SURFACE_ALLOWED_ORIGINS_MAX },
          (_, index) => `https://site${String(index)}.example.com`,
        ),
      };
      expect(withDeploymentOrigin(full, 'production', withOrigin)).toBe(full);
    } finally {
      warn.mockRestore();
    }
  });

  describe('through the runtime', () => {
    let state: Fixture;
    beforeEach(async () => {
      state = await fixture();
      state.productionSurface = true;
      state.promoted.add(state.agents.desk.id);
      state.env = {
        BOOTSTRAP_ADMIN: 'owner@example.com',
        BOOTSTRAP_ADMIN_PASSWORD: 'x'.repeat(12),
        ...withOrigin,
      };
    });

    it('widens the promoted surface the public is served, and not the try page draft', async () => {
      const served = await state.runtime.resolve('main', 'public');
      expect(served).toMatchObject({
        environment: 'production',
        surface: { allowedOrigins: [FRONTEND] },
      });
      const draft = await state.runtime.resolve('main', 'try');
      expect(draft?.environment).toBe('local');
      expect(draft?.surface.allowedOrigins).toBeUndefined();
    });

    it('does not widen a surface that is served from local before any promotion', async () => {
      state.productionSurface = false;
      state.promoted.delete(state.agents.desk.id);
      const served = await state.runtime.resolve('main', 'public');
      expect(served?.environment).toBe('local');
      expect(served?.surface.allowedOrigins).toBeUndefined();
    });

    it('resolves unchanged on a deployment that does not set the variable', async () => {
      state.env = {
        BOOTSTRAP_ADMIN: 'owner@example.com',
        BOOTSTRAP_ADMIN_PASSWORD: 'x'.repeat(12),
      };
      const served = await state.runtime.resolve('main', 'public');
      expect(served?.surface.allowedOrigins).toBeUndefined();
    });

    it('carries the origin into the served surfaces, so a visitor run answers CORS for it', async () => {
      const served = await state.runtime.servedSurfaces();
      expect(served).toEqual([
        { name: 'main', agent: 'Front desk', allowedOrigins: [FRONTEND], servedFrom: 'production' },
      ]);
    });

    it('admits a session from the frontend origin, with the default turn cap, and no other origin', async () => {
      const surface = (await state.runtime.resolve('main', 'public'))?.surface ?? null;
      expect(surface).not.toBeNull();
      const request = (origin: string) =>
        new Headers({
          host: 'aw.example.com',
          origin,
          'sec-fetch-site': 'cross-site',
        });
      expect(mayOpenSession(surface, request(FRONTEND), {}, 'session', 'production')).toEqual({
        ok: true,
        branch: 'allowed-origin',
        corsOrigin: FRONTEND,
      });
      expect(
        mayOpenSession(surface, request('https://evil.example.com'), {}, 'session', 'production'),
      ).toEqual({ ok: false, failed: 'origin-not-allowed' });
      if (surface === null) return;
      expect(turnsPerConversation(surface)).toBe(DEFAULT_TURNS_PER_CONVERSATION);
    });

    it('caps a visitor session the frontend opened, whose pinned version lists no origin', async () => {
      const opened = await state.runtime.open(
        (await state.runtime.resolve('main', 'public')) ?? state.resolved,
        {},
      );
      if (opened.kind !== 'opened') throw new Error(`expected a session, got ${opened.kind}`);
      const visitor = await state.runtime.visitorSurface(WORKSPACE_ID, opened.sessionId);
      expect(visitor?.surface?.allowedOrigins).toEqual([FRONTEND]);
    });
  });
});

describe('pickSurfaceVersion (issue #612)', () => {
  const AGENT = '77777777-7777-4777-8777-777777777777';
  const surfaceIn = (environment: 'local' | 'production') => ({
    agentId: AGENT,
    versionId: `${environment}-version`,
    number: environment === 'local' ? 2 : 1,
    surface: { name: 'main', agent: 'Front desk' },
  });
  function versions(carries: readonly ('local' | 'production')[], promoted: boolean) {
    return {
      findPointedSurface: (environment: 'local' | 'production') =>
        Promise.resolve(carries.includes(environment) ? surfaceIn(environment) : null),
      list: () =>
        Promise.resolve({
          versions: [],
          materialisedVersionId: null,
          pointers: (promoted ? (['local', 'production'] as const) : (['local'] as const)).map(
            (environment) => ({
              agentId: AGENT,
              environment,
              versionId: `${environment}-version`,
              number: 1,
              updatedAt: EXPIRES_AT,
            }),
          ),
        }),
    };
  }

  it('serves the public production when a production version carries the surface', async () => {
    await expect(
      pickSurfaceVersion(versions(['local', 'production'], true), 'main', 'public'),
    ).resolves.toMatchObject({ environment: 'production', promoted: true });
  });

  it('serves the public local before any promotion, and notes it is not promoted', async () => {
    await expect(
      pickSurfaceVersion(versions(['local'], false), 'main', 'public'),
    ).resolves.toMatchObject({
      environment: 'local',
      promoted: false,
      pointed: { versionId: 'local-version' },
    });
  });

  it('serves the public nothing when the promoted version lacks the surface', async () => {
    await expect(
      pickSurfaceVersion(versions(['local'], true), 'main', 'public'),
    ).resolves.toBeNull();
  });

  it('always serves the try page local, promoted or not', async () => {
    await expect(
      pickSurfaceVersion(versions(['local', 'production'], true), 'main', 'try'),
    ).resolves.toMatchObject({ environment: 'local', promoted: true });
    await expect(
      pickSurfaceVersion(versions(['production'], true), 'main', 'try'),
    ).resolves.toBeNull();
  });
});
