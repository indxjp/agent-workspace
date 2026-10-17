import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { auditEvents } from '../schema/audit-events.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseAuditEventRepositoryProvider } from './audit-events.js';
import type { KeysetPosition } from './keyset.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('AuditEventRepository keyset pages against PostgreSQL (S-5)', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceA = { id: crypto.randomUUID(), slug: 'audit-pages-a', name: 'Audit A' };
  const workspaceB = { id: crypto.randomUUID(), slug: 'audit-pages-b', name: 'Audit B' };

  function row(workspaceId: string, createdAt: Date) {
    return {
      id: crypto.randomUUID(),
      workspaceId,
      actorPrincipalId: null,
      actorLabel: 'system',
      action: 'agent-changed' as const,
      subjectId: null,
      subjectLabel: 'subject',
      createdAt,
    };
  }

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_audit_pages');
    await isolated.db.insert(workspaces).values([workspaceA, workspaceB]);
    const tie = new Date('2026-03-04T05:06:07.890Z');
    await isolated.db
      .insert(auditEvents)
      .values([
        row(workspaceA.id, new Date('2026-03-04T05:06:07.000Z')),
        row(workspaceA.id, tie),
        row(workspaceA.id, tie),
        row(workspaceA.id, tie),
        row(workspaceA.id, new Date('2026-03-04T05:06:08.000Z')),
        row(workspaceB.id, tie),
      ]);
  }, 180_000);

  afterAll(async () => isolated.close());

  async function repositoryFor(workspaceId: string) {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace does not resolve');
    return createDatabaseAuditEventRepositoryProvider(isolated.db).forScope(scope);
  }

  it('walks limit=1 pages over every row of the workspace exactly once, newest first', async () => {
    const repository = await repositoryFor(workspaceA.id);
    const whole = await repository.list({ limit: 500 });
    expect(whole.items).toHaveLength(5);
    expect(whole.nextCursor).toBeNull();

    const walked: string[] = [];
    let cursor: KeysetPosition | null = null;
    for (let pages = 0; pages < 10; pages += 1) {
      const page = await repository.list({ limit: 1, cursor });
      expect(page.items.length).toBeLessThanOrEqual(1);
      walked.push(...page.items.map((event) => event.id));
      if (pages === 0) {
        // Written mid-walk: newer than every boundary already handed out, so never visited.
        await repository.write({
          actorPrincipalId: null,
          actorLabel: 'system',
          action: 'agent-changed',
          subjectId: null,
          subjectLabel: 'late',
        });
      }
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(walked).toEqual(whole.items.map((event) => event.id));
    expect(new Set(walked).size).toBe(5);
  });

  it('never returns another workspace’s rows, whatever boundary it is handed', async () => {
    const repositoryB = await repositoryFor(workspaceB.id);
    const page = await repositoryB.list({
      limit: 500,
      cursor: { createdAt: '2999-01-01T00:00:00.000000Z', id: crypto.randomUUID() },
    });
    expect(page.items.map((event) => event.workspaceId)).toEqual([workspaceB.id]);
  });

  it('refuses a page size outside 1–500 before querying', async () => {
    const repository = await repositoryFor(workspaceA.id);
    await expect(repository.list({ limit: 0 })).rejects.toThrow(/limit/);
    await expect(repository.list({ limit: 501 })).rejects.toThrow(/limit/);
  });
});
