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
import crypto, { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { NextRequest } from 'next/server';

import { expect, it } from 'vitest';

import { sessions, surfaceSessionKeys } from '@agent-workspace/core/db/unscoped';

import { ApiProblemSchema } from '@indx-workspace/contracts';

import { GET as runEventsRoute } from '../../../app/api/runs/[id]/events/route';

import { GET as readRunRoute } from '../../../app/api/runs/[id]/route';

import {
  BILLING,
  createSurfaceSessionFixture,
  ORIGIN,
  STRANGER,
} from './surface-sessions.test-support';

export function registerResumeTests(fixture: ReturnType<typeof createSurfaceSessionFixture>) {
  it(
    'resumes a session with its key: the same id, and a token that reaches its earlier run',
    () => resumesSessionKeySameIdTokenThatReaches(fixture),
    60_000,
  );

  it('stores only the SHA-256 of the resume key', () => storesOnlySHA256ResumeKey(fixture), 60_000);

  it(
    'answers a wrong key exactly as an unknown session: 404 surface_session_not_resumable',
    () => answersWrongKeyExactlyUnknownSession404Surface(fixture),
    60_000,
  );

  it(
    'refuses an agent the surface does not offer, and an offered one of another owner',
    () => refusesAgentSurfaceDoesNotOfferOfferedOne(fixture),
    60_000,
  );

  it(
    'opens a switcher session as the offered agent and its owner, and runs in it',
    () => opensSwitcherSessionOfferedAgentOwnerRunsIt(fixture),
    60_000,
  );

  it(
    'switches A → B → A: A key resumes A, and B key never resumes A',
    () => switchesBKeyResumesBKeyNeverResumes(fixture),
    60_000,
  );

  it('does not resume an archived session', () => doesNotResumeArchivedSession(fixture), 60_000);
}

async function resumesSessionKeySameIdTokenThatReaches(
  fixture: ReturnType<typeof createSurfaceSessionFixture>,
) {
  const first = await fixture.opened();
  const started = await fixture.startRun(first.token, first.sessionId);
  expect(started.status, await started.clone().text()).toBe(202);
  const runId = ((await started.json()) as { run: { id: string } }).run.id;

  const resumed = await fixture.opened({ resume: fixture.resumeOf(first) });
  expect(resumed.sessionId).toBe(first.sessionId);
  expect(resumed.agentId).toBe(fixture.agentIds.main);
  expect(resumed.resumeKey).toBeUndefined();
  expect(resumed.token).not.toBe(first.token);

  const bearer = { authorization: `Bearer ${resumed.token}` };
  const read = await readRunRoute(
    new NextRequest(`${ORIGIN}/api/runs/${runId}`, { headers: bearer }),
    { params: Promise.resolve({ id: runId }) },
  );
  expect(read.status, await read.clone().text()).toBe(200);
  const abort = new AbortController();
  const events = await runEventsRoute(
    new NextRequest(`${ORIGIN}/api/runs/${runId}/events`, {
      headers: bearer,
      signal: abort.signal,
    }),
    { params: Promise.resolve({ id: runId }) },
  );
  expect(events.status).toBe(200);
  abort.abort();
  await events.body?.cancel();

  const again = await fixture.startRun(resumed.token, first.sessionId);
  expect(again.status, await again.clone().text()).toBe(202);
}

async function storesOnlySHA256ResumeKey(fixture: ReturnType<typeof createSurfaceSessionFixture>) {
  const session = await fixture.opened();
  const [row] = await fixture
    .db()
    .db.select()
    .from(surfaceSessionKeys)
    .where(eq(surfaceSessionKeys.sessionId, session.sessionId));
  const { resumeKey } = fixture.resumeOf(session);
  expect(row?.keyHash).not.toBe(resumeKey);
  expect(row?.keyHash).toBe(createHash('sha256').update(resumeKey).digest('hex'));
  expect(row).toMatchObject({ surfaceName: 'main', agentId: fixture.agentIds.main });
}

async function answersWrongKeyExactlyUnknownSession404Surface(
  fixture: ReturnType<typeof createSurfaceSessionFixture>,
) {
  const session = await fixture.opened();
  const wrong = await fixture.bootstrap('main', {
    resume: { sessionId: session.sessionId, resumeKey: 'x'.repeat(43) },
  });
  const unknown = await fixture.bootstrap('main', {
    resume: { sessionId: crypto.randomUUID(), resumeKey: fixture.resumeOf(session).resumeKey },
  });
  expect(wrong.status).toBe(404);
  expect(unknown.status).toBe(404);
  const wrongBody: unknown = await wrong.json();
  expect(wrongBody).toEqual(await unknown.json());
  expect(ApiProblemSchema.parse(wrongBody).error.code).toBe('surface_session_not_resumable');
}

async function refusesAgentSurfaceDoesNotOfferOfferedOne(
  fixture: ReturnType<typeof createSurfaceSessionFixture>,
) {
  const before = await fixture.sessionCount();
  for (const agent of ['other', STRANGER]) {
    const response = await fixture.bootstrap('main', { agent });
    expect(response.status).toBe(404);
    await expect(fixture.codeOf(response)).resolves.toBe('surface_agent_not_offered');
  }
  expect(await fixture.sessionCount()).toBe(before);
}

async function opensSwitcherSessionOfferedAgentOwnerRunsIt(
  fixture: ReturnType<typeof createSurfaceSessionFixture>,
) {
  const session = await fixture.opened({ agent: BILLING });
  expect(session.agentId).toBe(fixture.agentIds.billing);
  const [row] = await fixture
    .db()
    .db.select()
    .from(sessions)
    .where(eq(sessions.id, session.sessionId));
  expect(row?.agentId).toBe(fixture.agentIds.billing);
  expect(row?.ownerPrincipalId).toBe(fixture.owner.principalId);
  const started = await fixture.startRun(
    session.token,
    session.sessionId,
    fixture.agentIds.billing,
  );
  expect(started.status, await started.clone().text()).toBe(202);
}

async function switchesBKeyResumesBKeyNeverResumes(
  fixture: ReturnType<typeof createSurfaceSessionFixture>,
) {
  const desk = await fixture.opened();
  const billing = await fixture.opened({ agent: BILLING });
  const back = await fixture.opened({ resume: fixture.resumeOf(desk) });
  expect(back.sessionId).toBe(desk.sessionId);
  expect(back.agentId).toBe(fixture.agentIds.main);

  const crossed = await fixture.bootstrap('main', {
    resume: { sessionId: desk.sessionId, resumeKey: fixture.resumeOf(billing).resumeKey },
  });
  expect(crossed.status).toBe(404);
  await expect(fixture.codeOf(crossed)).resolves.toBe('surface_session_not_resumable');
  const billingBack = await fixture.opened({ agent: BILLING, resume: fixture.resumeOf(billing) });
  expect(billingBack.sessionId).toBe(billing.sessionId);
}

async function doesNotResumeArchivedSession(
  fixture: ReturnType<typeof createSurfaceSessionFixture>,
) {
  const session = await fixture.opened();
  await fixture
    .db()
    .db.update(sessions)
    .set({ status: 'archived' })
    .where(eq(sessions.id, session.sessionId));
  const response = await fixture.bootstrap('main', { resume: fixture.resumeOf(session) });
  expect(response.status).toBe(404);
  await expect(fixture.codeOf(response)).resolves.toBe('surface_session_not_resumable');
}
