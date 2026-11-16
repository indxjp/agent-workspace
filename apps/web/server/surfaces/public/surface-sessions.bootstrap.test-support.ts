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

import { openDatabaseRoot } from '@agent-workspace/core/db';

import { sessions } from '@agent-workspace/core/db/unscoped';

import { SurfaceSessionResponseSchema } from '@indx-workspace/contracts/surfaces';

import { POST as createAgentRoute } from '../../../app/api/agents/route';

import { issueLocalApiKey } from '../../cli-auth/local-credential';

import {
  agentWithSurface,
  createSurfaceSessionFixture,
  ORIGIN,
  PROFILE_NAME,
} from './surface-sessions.test-support';

export function registerBootstrapTests(fixture: ReturnType<typeof createSurfaceSessionFixture>) {
  it(
    'opens a session owned by the agent owner and starts a run in it with the token',
    () => opensSessionOwnedAgentOwnerStartsRunIt(fixture),
    60_000,
  );

  it(
    'refuses the token in any other session with 403 token_out_of_scope',
    () => refusesTokenAnyOtherSession403TokenOut(fixture),
    60_000,
  );

  it(
    'still opens a session for an agent a since-revoked local runtime key pushed (S1-24)',
    () => stillOpensSessionAgentSinceRevokedLocalRuntime(fixture),
    60_000,
  );

  it(
    'answers 404 surface_not_found for a surface nothing serves',
    () => answers404SurfaceNotFoundSurfaceNothingServes(fixture),
    60_000,
  );

  it(
    'refuses an agent the preflight refuses with 422, and opens no session',
    () => refusesAgentPreflightRefuses422OpensNoSession(fixture),
    60_000,
  );
}

async function opensSessionOwnedAgentOwnerStartsRunIt(
  fixture: ReturnType<typeof createSurfaceSessionFixture>,
) {
  const response = await fixture.bootstrap('main');
  expect(response.status, await response.clone().text()).toBe(201);
  expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
  const session = SurfaceSessionResponseSchema.parse(await response.json());
  expect(session.agentId).toBe(fixture.agentIds.main);

  const [row] = await fixture
    .db()
    .db.select()
    .from(sessions)
    .where(eq(sessions.id, session.sessionId));
  expect(row?.ownerPrincipalId).toBe(fixture.owner.principalId);
  expect(row?.agentId).toBe(fixture.agentIds.main);

  const started = await fixture.startRun(session.token, session.sessionId);
  expect(started.status, await started.clone().text()).toBe(202);
}

async function refusesTokenAnyOtherSession403TokenOut(
  fixture: ReturnType<typeof createSurfaceSessionFixture>,
) {
  const first = SurfaceSessionResponseSchema.parse(await (await fixture.bootstrap('main')).json());
  const second = SurfaceSessionResponseSchema.parse(await (await fixture.bootstrap('main')).json());
  expect(second.sessionId).not.toBe(first.sessionId);

  const crossed = await fixture.startRun(first.token, second.sessionId);
  expect(crossed.status).toBe(403);
  await expect(fixture.codeOf(crossed)).resolves.toBe('token_out_of_scope');
}

async function stillOpensSessionAgentSinceRevokedLocalRuntime(
  fixture: ReturnType<typeof createSurfaceSessionFixture>,
) {
  const root = await openDatabaseRoot({ DATABASE_URL: fixture.db().url });
  try {
    const directory = root.directory.forWorkspace(fixture.workspaceId);
    const admin = await directory.createUser({
      email: 'admin@surface-sessions.test',
      name: 'Admin',
      role: 'owner',
    });
    if (admin.kind !== 'created') throw new Error(admin.kind);
    const local = await issueLocalApiKey(
      { workspaceId: fixture.workspaceId, userId: admin.user.id },
      { directory: root.directory },
    );
    const response = await createAgentRoute(
      new Request(`${ORIGIN}/api/agents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${local.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(
          agentWithSurface({
            name: 'Local desk',
            surface: 'desk',
            runtimeProfileName: PROFILE_NAME,
          }),
        ),
      }),
    );
    const text = await response.text();
    expect(response.status, text).toBe(201);
    const created = JSON.parse(text) as { agent: { id: string; ownerPrincipalId: string } };
    expect(created.agent.ownerPrincipalId).toBe(admin.membership.principalId);

    await expect(local.revoke()).resolves.toBe('revoked');
    const opened = await fixture.bootstrap('desk');
    expect(opened.status, await opened.clone().text()).toBe(201);
    const session = SurfaceSessionResponseSchema.parse(await opened.json());
    expect(session.agentId).toBe(created.agent.id);
    const [row] = await fixture
      .db()
      .db.select()
      .from(sessions)
      .where(eq(sessions.id, session.sessionId));
    expect(row?.ownerPrincipalId).toBe(admin.membership.principalId);
  } finally {
    await root.close();
  }
}

async function answers404SurfaceNotFoundSurfaceNothingServes(
  fixture: ReturnType<typeof createSurfaceSessionFixture>,
) {
  const response = await fixture.bootstrap('unknown');
  expect(response.status).toBe(404);
  await expect(fixture.codeOf(response)).resolves.toBe('surface_not_found');
}

async function refusesAgentPreflightRefuses422OpensNoSession(
  fixture: ReturnType<typeof createSurfaceSessionFixture>,
) {
  const before = await fixture.sessionCount();
  const response = await fixture.bootstrap('bare');
  expect(response.status).toBe(422);
  await expect(fixture.codeOf(response)).resolves.toBe('agent_runtime_profile_missing');
  expect(await fixture.sessionCount()).toBe(before);
}
