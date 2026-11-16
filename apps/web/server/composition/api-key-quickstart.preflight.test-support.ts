import {
  BASE_URL,
  serve,
  client,
  refusal,
  AGENT_BODY,
} from './api-key-quickstart.transport.test-support';
import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { runs, sessions, workspacePrincipals } from '@agent-workspace/core/db/unscoped';
import { eq } from 'drizzle-orm';
import type { ApiKeyQuickstartFixture } from './api-key-quickstart.fixture.test-support';

export function registerApiKeyQuickstartPreflightTests(
  getFixture: () => Pick<
    ApiKeyQuickstartFixture,
    'key' | 'fixtureConnectionId' | 'isolated' | 'fixtureWorkspaceId' | 'keys'
  >,
) {
  // PR #403 review: a refused first message is decided before its session is opened, so it
  // leaves neither a run nor an empty session behind. Last in the file: it adds a third agent.
  it('refuses a profile-less agent with 422 and creates no run and no session', async () => {
    const testContext = getFixture();

    const created = await serve(`${BASE_URL}/api/agents`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${testContext.key('owner')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...AGENT_BODY,
        modelConnectionId: testContext.fixtureConnectionId,
        name: 'Unprofiled',
      }),
    });
    expect(created.status).toBe(201);
    const { id: unprofiledId } = (await created.json()) as { id: string };
    const count = async (): Promise<{ sessions: number; runs: number }> => ({
      sessions: (
        await testContext
          .isolated!.db.select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.workspaceId, testContext.fixtureWorkspaceId))
      ).length,
      runs: (
        await testContext
          .isolated!.db.select({ id: runs.id })
          .from(runs)
          .where(eq(runs.workspaceId, testContext.fixtureWorkspaceId))
      ).length,
    });
    const before = await count();

    const problem = await refusal(() =>
      client(testContext.key('owner')).runs.start(unprofiledId, { prompt: 'Hello.' }),
    );
    expect(problem.status).toBe(422);
    expect(problem.code).toBe('agent_runtime_profile_missing');
    expect(await count()).toEqual(before);

    // A session the client opened itself (as `projects.startSession` does) stays the client's: a
    // refused first start neither runs in it nor deletes it, so a retry with the same id is
    // refused for the same reason, never answered 409 session_not_usable.
    const [ownerPrincipal] = await testContext
      .isolated!.db.select({ id: workspacePrincipals.id })
      .from(workspacePrincipals)
      .where(eq(workspacePrincipals.apiKeyId, testContext.keys.get('owner')?.id ?? ''));
    if (ownerPrincipal === undefined) throw new Error('the owner key has no principal');
    const openedFirst = crypto.randomUUID();
    await testContext.isolated!.db.insert(sessions).values({
      id: openedFirst,
      workspaceId: testContext.fixtureWorkspaceId,
      agentId: unprofiledId,
      ownerPrincipalId: ownerPrincipal.id,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refused = await refusal(() =>
        client(testContext.key('owner')).runs.start(unprofiledId, {
          prompt: 'Hello.',
          sessionId: openedFirst,
        }),
      );
      expect(refused.code).toBe('agent_runtime_profile_missing');
    }
    expect(await count()).toEqual({ sessions: before.sessions + 1, runs: before.runs });
  });
}
