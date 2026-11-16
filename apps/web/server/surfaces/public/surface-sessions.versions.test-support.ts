/**
 * The hosted surface page's local session bootstrap **as `register()` composes it** (ADR-0105
 * slice 1; S1-17, issue #455).
 *
 * `handlers.test.ts` proves the order of the answers against a fake runtime. This file proves the
 * PostgreSQL wiring and the token's reach: an agent is created through `POST /api/agents {version}`
 * with a surface `main`, which points `local` at its version 1 (C9); the bootstrap route then
 * resolves that surface in the bootstrap workspace, opens a session as the agent's owner and mints
 * a session-scoped browser token through the real tokens runtime. That token starts a run in its
 * own session and nowhere else (`requireSessionScopeMatch`, `403 token_out_of_scope`), and a
 * refused preflight opens no session at all.
 *
 * The fixture shape is `../../composition/api-key-quickstart.integration.test.ts`'s: a runtime
 * profile and a ready model connection whose model list is a loopback stand-in, so the run
 * preflight passes offline, and a run API whose `launch` settles nothing.
 *
 * S1-24 (issue #509): an agent pushed with the per-run local runtime key is owned by the admin the
 * key acts for, so revoking the key (the stop, or the next start's sweep) leaves its surface open.
 * Before the fix the agent was owned by the key's principal, which stops resolving once the key is
 * revoked, and the bootstrap answered 404 `surface_not_found`.
 *
 * S2-05b (issue #538): surface `main` offers "Billing desk" (the same owner) and "Stranger desk"
 * (another API-key principal's). A resume key resumes exactly its (surface, agent) session, and
 * a switch opens a session as the offered agent's owner; the stranger's agent is never offered.
 */

import { eq } from 'drizzle-orm';

import { expect, it } from 'vitest';

import { sessions } from '@agent-workspace/core/db/unscoped';

import {
  SurfaceSessionResponseSchema,
  type SurfaceSessionResponse,
} from '@indx-workspace/contracts/surfaces';

import { PUT as setPointerRoute } from '../../../app/api/agents/[id]/pointers/route';

import { POST as createVersionRoute } from '../../../app/api/agents/[id]/versions/route';

import { POST as createAgentRoute } from '../../../app/api/agents/route';

import { POST as createSurfaceSessionRoute } from '../../../app/p/s/[name]/sessions/route';

import {
  agentWithSurface,
  BILLING,
  createSurfaceSessionFixture,
  ORIGIN,
  PROFILE_NAME,
  SHOP_ORIGIN,
} from './surface-sessions.test-support';

export function registerVersionsTests(fixture: ReturnType<typeof createSurfaceSessionFixture>) {
  it(
    'opens a session for an allowed origin off loopback, and caps its turns (#622)',
    () => opensSessionAllowedOriginOffLoopbackCapsTurns(fixture),
    60_000,
  );

  it(
    'serves the public the production version and the try page local, pinning each (#612)',
    () => servesPublicProductionVersionTryPageLocalPinning(fixture),
    60_000,
  );

  it(
    'keeps a visitor on the version it opened on, with its turn cap, after a promote (#622)',
    () => keepsVisitorVersionItOpenedTurnCapAfter(fixture),
    60_000,
  );
}

async function opensSessionAllowedOriginOffLoopbackCapsTurns(
  fixture: ReturnType<typeof createSurfaceSessionFixture>,
) {
  const response = await createSurfaceSessionRoute(
    new Request('https://aw.example.com/p/s/shop/sessions', {
      method: 'POST',
      headers: { host: 'aw.example.com', origin: SHOP_ORIGIN, 'sec-fetch-site': 'cross-site' },
    }),
    { params: Promise.resolve({ name: 'shop' }) },
  );
  expect(response.status, await response.clone().text()).toBe(201);
  expect(response.headers.get('access-control-allow-origin')).toBe(SHOP_ORIGIN);
  const session = SurfaceSessionResponseSchema.parse(await response.json());

  const first = await fixture.startRun(session.token, session.sessionId, fixture.agentIds.shop);
  expect(first.status, await first.clone().text()).toBe(202);
  const before = await fixture.sessionCount();
  const second = await fixture.startRun(session.token, session.sessionId, fixture.agentIds.shop);
  expect(second.status).toBe(429);
  await expect(fixture.codeOf(second)).resolves.toBe('surface_turn_limit_reached');
  expect(await fixture.sessionCount()).toBe(before);

  const refused = await createSurfaceSessionRoute(
    new Request('https://aw.example.com/p/s/shop/sessions', {
      method: 'POST',
      headers: { host: 'aw.example.com', origin: 'https://evil.example' },
    }),
    { params: Promise.resolve({ name: 'shop' }) },
  );
  expect(refused.status).toBe(403);
  await expect(fixture.codeOf(refused)).resolves.toBe('surface_origin_not_allowed');
}

async function servesPublicProductionVersionTryPageLocalPinning(
  fixture: ReturnType<typeof createSurfaceSessionFixture>,
) {
  const headers = {
    authorization: `Bearer ${fixture.owner.key}`,
    'content-type': 'application/json',
  };
  const params = { params: Promise.resolve({ id: fixture.agentIds.billing }) };
  const point = (environment: string, version: number) =>
    pointAgent(fixture.owner.key, fixture.agentIds.billing, { environment, version });
  const pinOf = async (response: Response): Promise<string | null | undefined> => {
    expect(response.status, await response.clone().text()).toBe(201);
    const { sessionId } = SurfaceSessionResponseSchema.parse(await response.json());
    const [row] = await fixture
      .db()
      .db.select({ pin: sessions.agentVersionId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    return row?.pin;
  };
  const before = await pinOf(await fixture.bootstrap('billing'));

  // Promote v1, then `aw push` v2: a new version, and `local` moved onto it.
  await point('production', 1);
  const { version } = agentWithSurface({
    name: BILLING,
    surface: 'billing',
    runtimeProfileName: PROFILE_NAME,
  }) as {
    version: Record<string, unknown>;
  };
  const saved = await createVersionRoute(
    new Request(`${ORIGIN}/api/agents/${fixture.agentIds.billing}/versions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...version, summary: 'Second version' }),
    }),
    params,
  );
  expect(saved.status, await saved.text()).toBe(201);
  await point('local', 2);

  const publicPin = await pinOf(await fixture.bootstrap('billing'));
  const tryPin = await pinOf(await fixture.bootstrap('billing', { environment: 'local' }));
  expect(publicPin).toBe(before);
  expect(tryPin).not.toBe(before);
  expect(tryPin).toEqual(expect.any(String));
}

async function keepsVisitorVersionItOpenedTurnCapAfter(
  fixture: ReturnType<typeof createSurfaceSessionFixture>,
) {
  const headers = {
    authorization: `Bearer ${fixture.owner.key}`,
    'content-type': 'application/json',
  };

  const created = await createAgentRoute(
    new Request(`${ORIGIN}/api/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify(embedded(1)),
    }),
  );
  expect(created.status, await created.clone().text()).toBe(201);
  const pinnedId = ((await created.json()) as { agent: { id: string } }).agent.id;
  const params = { params: Promise.resolve({ id: pinnedId }) };
  const point = (environment: string, version: number) =>
    pointAgent(fixture.owner.key, pinnedId, { environment, version });
  const visitor = async (): Promise<SurfaceSessionResponse> => {
    const response = await createSurfaceSessionRoute(
      new Request('https://aw.example.com/p/s/pinned/sessions', {
        method: 'POST',
        headers: { host: 'aw.example.com', origin: SHOP_ORIGIN, 'sec-fetch-site': 'cross-site' },
      }),
      { params: Promise.resolve({ name: 'pinned' }) },
    );
    expect(response.status, await response.clone().text()).toBe(201);
    return SurfaceSessionResponseSchema.parse(await response.json());
  };
  const pinOf = async (sessionId: string): Promise<string | null | undefined> =>
    (
      await fixture
        .db()
        .db.select({ pin: sessions.agentVersionId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
    )[0]?.pin;

  // v1 (one turn per conversation) is in production when the visitor opens a conversation.
  await point('production', 1);
  const onV1 = await visitor();
  const v1 = await pinOf(onV1.sessionId);
  expect(v1).toEqual(expect.any(String));

  // v2 (three turns) is saved and promoted while that conversation is open.
  const saved = await createVersionRoute(
    new Request(`${ORIGIN}/api/agents/${pinnedId}/versions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...embedded(3).version, summary: 'Second version' }),
    }),
    params,
  );
  expect(saved.status, await saved.text()).toBe(201);
  await point('local', 2);
  await point('production', 2);

  const first = await fixture.startRun(onV1.token, onV1.sessionId, pinnedId);
  expect(first.status, await first.clone().text()).toBe(202);
  const second = await fixture.startRun(onV1.token, onV1.sessionId, pinnedId);
  expect(second.status).toBe(429);
  await expect(fixture.codeOf(second)).resolves.toBe('surface_turn_limit_reached');
  expect(await pinOf(onV1.sessionId)).toBe(v1);

  // A conversation opened after the promote runs v2, under v2's cap.
  const onV2 = await visitor();
  expect(await pinOf(onV2.sessionId)).not.toBe(v1);
  for (let turn = 0; turn < 2; turn += 1) {
    const started = await fixture.startRun(onV2.token, onV2.sessionId, pinnedId);
    expect(started.status, await started.clone().text()).toBe(202);
  }
}

async function pointAgent(
  ownerKey: string,
  agentId: string,
  pointer: { environment: string; version: number },
) {
  const moved = await setPointerRoute(
    new Request(`${ORIGIN}/api/agents/${agentId}/pointers`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(pointer),
    }),
    { params: Promise.resolve({ id: agentId }) },
  );
  expect(moved.status, await moved.text()).toBe(200);
}

const embedded = (turnsPerConversation: number) =>
  agentWithSurface({
    name: 'Pinned shop',
    surface: 'pinned',
    runtimeProfileName: PROFILE_NAME,
    switcher: [],
    embedding: {
      allowedOrigins: [SHOP_ORIGIN],
      limits: { turnsPerConversation },
    },
  }) as { version: Record<string, unknown> };
