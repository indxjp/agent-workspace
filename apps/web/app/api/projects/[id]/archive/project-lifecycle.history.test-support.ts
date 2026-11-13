/**
 * `POST /api/projects/:id/archive` and `POST /api/projects/:id/restore` against a real PostgreSQL —
 * issue #183's role matrix, its concealment rule, its idempotence-with-audit rule and its
 * history-attribution criterion, driven with real `Request` objects through the route handlers
 * exactly as Next.js calls them.
 *
 * Shape borrowed from `../default-model.test.ts` (`createIsolatedTestDatabase` + `openDatabaseRoot`
 * + `describe.skipIf(!hasDatabase)`), with one difference that matters: the actor header carries a
 * real `users.id`, not an email, because `projects.created_by` and `audit_events.actor_user_id` are
 * both `uuid` foreign keys and the own/other split this file is about is a comparison against the
 * former.
 */
import crypto from 'node:crypto';

import { expect, it } from 'vitest';

import { GET as GET_PROJECT } from '../route';

import { GET as LIST_PROJECTS } from '../../route';

import {
  ACTOR_HEADER,
  createScopedFixture,
  creator,
  idContext,
  ownerA,
  PRINCIPAL_IDS,
  WORKSPACE_HEADER,
  workspaceA,
} from './project-lifecycle.test-support';

export function registerHistoryTests(fixture: ReturnType<typeof createScopedFixture>) {
  it('keeps session and run history attributed to the project after it is archived', async () => {
    const scopeA = await fixture.root.scopes.forWorkspaceId(workspaceA.id);
    if (scopeA === null) throw new Error('workspace A did not resolve');
    const session = await fixture.root.sessions.forScope(scopeA).ensure({
      id: crypto.randomUUID(),
      agentId: fixture.agentId,
      userId: creator.id,
      ownerPrincipalId: PRINCIPAL_IDS.creator,
      projectId: fixture.projectId,
    });
    if (session.kind !== 'created') throw new Error(`fixture session failed: ${session.kind}`);
    const run = await fixture.root.runs.forScope(scopeA).create({
      engine: 'claude-agent-sdk',
      id: crypto.randomUUID(),
      sessionId: session.session.id,
    });
    if (run.kind !== 'created') throw new Error(`fixture run failed: ${run.kind}`);

    expect((await fixture.archive(ownerA.id)).status).toBe(200);

    // The project itself still reads, with its lifecycle state visible.
    const fetched = await GET_PROJECT(
      new Request(`https://example.invalid/api/projects/${fixture.projectId}`, {
        headers: { [WORKSPACE_HEADER]: workspaceA.id, [ACTOR_HEADER]: ownerA.id },
      }),
      idContext(fixture.projectId),
    );
    expect(fetched.status, await fetched.clone().text()).toBe(200);
    expect(((await fetched.json()) as { archivedAt: string | null }).archivedAt).not.toBeNull();

    // …and both the session and the run still resolve to it.
    expect((await fixture.root.sessions.forScope(scopeA).get(session.session.id))?.projectId).toBe(
      fixture.projectId,
    );
    const page = await fixture.root.runs
      .forScope(scopeA)
      .listRuns?.({ filter: { projectId: fixture.projectId }, limit: 10 });
    expect(page?.items.map((item) => item.id)).toEqual([run.run.id]);
  });

  it('hides an archived project from the default listing and returns it on ?archived=all', async () => {
    await fixture.archive(ownerA.id);

    const listed = async (query: string): Promise<readonly string[]> => {
      const response = await LIST_PROJECTS(
        new Request(`https://example.invalid/api/projects${query}`, {
          headers: { [WORKSPACE_HEADER]: workspaceA.id, [ACTOR_HEADER]: ownerA.id },
        }),
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as { projects: readonly { id: string }[] };
      return body.projects.map((project) => project.id);
    };

    expect(await listed('')).not.toContain(fixture.projectId);
    expect(await listed('?archived=all')).toContain(fixture.projectId);
    expect(await listed('?archived=archived')).toContain(fixture.projectId);
    expect(await listed('?archived=active')).not.toContain(fixture.projectId);

    const invalid = await LIST_PROJECTS(
      new Request('https://example.invalid/api/projects?archived=yes', {
        headers: { [WORKSPACE_HEADER]: workspaceA.id, [ACTOR_HEADER]: ownerA.id },
      }),
    );
    expect(invalid.status, await invalid.clone().text()).toBe(400);
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_project',
    );
  });
}
