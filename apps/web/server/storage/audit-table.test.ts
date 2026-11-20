import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { auditActions, auditEvents, workspaces } from '@agent-workspace/core/db/unscoped';
import { openDatabaseRoot } from '@agent-workspace/core/db';
import { AUDIT_ACTIONS } from '@indx-workspace/contracts/observability';

import { useIsolatedAuditDatabase } from './audit.test-support';

const database = useIsolatedAuditDatabase();

describe('the audit table keeps one row per audit key', () => {
  // @story US-STO-04
  it('[US-STO-04][api][sdk] recording the same key twice writes one row', async () => {
    const isolated = database();
    const root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
    try {
      const workspaceId = crypto.randomUUID();
      await isolated.db
        .insert(workspaces)
        .values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'audit key' });
      const event = {
        id: crypto.randomUUID(),
        workspaceId,
        actorPrincipalId: null,
        actorLabel: 'Ito',
        action: 'file-deleted' as const,
        subjectId: crypto.randomUUID(),
        subjectLabel: 'a.txt',
      };
      await root.recordAuditEvent(event);
      await root.recordAuditEvent(event);
      const rows = await isolated.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.workspaceId, workspaceId));
      expect(rows.map((row) => row.id)).toEqual([event.id]);
    } finally {
      await root.close();
    }
  });
});

describe('the audit table accepts every file action', () => {
  // @story US-STO-04
  it('[US-STO-04][api][sdk] the database constraint admits the five file actions and the lists agree', async () => {
    const { db } = database();
    const workspaceId = crypto.randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'audit' });
    const actions = [
      'file-uploaded',
      'file-downloaded',
      'file-link-created',
      'file-moved',
      'file-deleted',
    ] as const;
    await db.insert(auditEvents).values(
      actions.map((action) => ({
        workspaceId,
        actorPrincipalId: null,
        actorLabel: 'Ito',
        action,
        subjectId: crypto.randomUUID(),
        subjectLabel: 'a.txt',
      })),
    );
    for (const action of actions) expect(auditActions).toContain(action);
    expect([...auditActions]).toEqual([...AUDIT_ACTIONS]);
  });
});
