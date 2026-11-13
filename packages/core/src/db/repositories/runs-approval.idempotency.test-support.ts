import crypto from 'node:crypto';

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { CALL, type RunsApprovalFixture } from './runs-approval.fixture.test-support.js';

function lookupCases(fixture: RunsApprovalFixture): void {
  const { principalId, seedSession } = fixture;
  const key = (): { principalId: string; key: string; requestHash: string } => ({
    principalId,
    key: crypto.randomUUID(),
    requestHash: 'a'.repeat(64),
  });

  it('is found again with its request hash, and holds across a pause', async () => {
    const { repository } = fixture;
    const idempotency = key();
    const sessionId = await seedSession();
    const runId = crypto.randomUUID();
    await repository.create({ id: runId, sessionId, engine: 'claude-agent-sdk', idempotency });
    await repository.markRunning(runId);
    await repository.awaitApproval(runId, CALL);

    const found = await repository.findByIdempotencyKey(principalId, idempotency.key);

    expect(found?.run.id).toBe(runId);
    expect(found?.run.status).toBe('awaiting_approval');
    expect(found?.requestHash).toBe(idempotency.requestHash);
    // The pause frees the session, never the key.
    const again = await repository.create({
      id: crypto.randomUUID(),
      sessionId,
      engine: 'claude-agent-sdk',
      idempotency,
    });
    expect(again).toEqual({ kind: 'idempotency-key-taken', key: idempotency.key });
  });

  it('is scoped to the principal', async () => {
    const { repository } = fixture;
    const idempotency = key();
    await repository.create({
      id: crypto.randomUUID(),
      sessionId: await seedSession(),
      engine: 'claude-agent-sdk',
      idempotency,
    });
    await expect(
      repository.findByIdempotencyKey(crypto.randomUUID(), idempotency.key),
    ).resolves.toBeNull();
    const other = await repository.create({
      id: crypto.randomUUID(),
      sessionId: await seedSession(),
      engine: 'claude-agent-sdk',
      idempotency: { ...idempotency, principalId: crypto.randomUUID() },
    });
    expect(other.kind).toBe('created');
  });
}

export function registerIdempotencyCases(fixture: RunsApprovalFixture): void {
  describe('the start idempotency key (ADR-0151, #250)', () => {
    lookupCases(fixture);

    it('is held by the database: a key always has its hash', async () => {
      const { runId } = await fixture.seedRunning();
      await expect(
        fixture.isolated.db.execute(sql`update runs set idempotency_key = 'k' where id = ${runId}`),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof Error &&
          error.cause instanceof Error &&
          error.cause.message.includes('runs_idempotency_key_has_hash'),
      );
    });
  });
}
