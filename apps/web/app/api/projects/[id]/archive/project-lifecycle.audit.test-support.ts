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

import { expect, it } from 'vitest';

import {
  createScopedFixture,
  ownerA,
  workspaceA,
  workspaceB,
} from './project-lifecycle.test-support';

export function registerAuditTests(fixture: ReturnType<typeof createScopedFixture>) {
  it('is idempotent, and audits the transition rather than the request', async () => {
    const first = await fixture.archive(ownerA.id);
    const firstAt = ((await first.json()) as { archivedAt: string }).archivedAt;
    const second = await fixture.archive(ownerA.id);
    expect(second.status, await second.clone().text()).toBe(200);
    expect(((await second.json()) as { archivedAt: string }).archivedAt).toBe(firstAt);
    expect(
      (await fixture.auditRows()).filter((row) => row.action === 'project-archived'),
    ).toHaveLength(1);

    await fixture.restore(ownerA.id);
    const secondRestore = await fixture.restore(ownerA.id);
    expect(secondRestore.status).toBe(200);
    expect(((await secondRestore.json()) as { archivedAt: null }).archivedAt).toBeNull();
    const rows = await fixture.auditRows();
    expect(rows.filter((row) => row.action === 'project-restored')).toHaveLength(1);
    expect(rows.map((row) => row.action).sort()).toEqual(['project-archived', 'project-restored']);
  });

  it('records who acted and on what, and nothing else — no credential, no foreign id', async () => {
    await fixture.archive(ownerA.id);
    const scopeA = await fixture.root.scopes.forWorkspaceId(workspaceA.id);
    if (scopeA === null) throw new Error('workspace A did not resolve');
    const row = (
      await fixture.root.auditEventRepository.forScope(scopeA).list({ limit: 500 })
    ).items.find((candidate) => candidate.subjectId === fixture.projectId);
    expect(row?.action).toBe('project-archived');
    expect(row?.actorUserId).toBe(ownerA.id);
    expect(row?.workspaceId).toBe(workspaceA.id);
    // Workspace B's id and the API key the principal authenticated with appear nowhere.
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(workspaceB.id);
    expect(serialised).not.toContain('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  });
}
