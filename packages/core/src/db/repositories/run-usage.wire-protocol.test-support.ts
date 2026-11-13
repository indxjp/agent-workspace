import crypto from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { runUsageRecords } from '../schema/run-usage-records.js';
import { runs } from '../schema/runs.js';
import { usage, type RunUsageFixture } from './run-usage.fixture.test-support.js';

async function defaultsWireProtocol(fixture: RunUsageFixture) {
  // The compatibility the migration exists for (ADR-0068): `migrate` runs at container start, so
  // a gateway pod from the previous release keeps inserting rows that name no protocol.
  const { workspaceId, sessionId } = fixture;
  const { db } = fixture.isolated;
  const legacyRunId = crypto.randomUUID();
  await db.insert(runs).values({ id: legacyRunId, workspaceId, sessionId });
  await db.execute(sql`
    insert into run_usage_records
      (workspace_id, run_id, provider_response_id, provider, model, input_tokens, output_tokens, cost_usd)
    values (${workspaceId}, ${legacyRunId}, 'msg_legacy', 'anthropic', 'claude-fixture', 5, 2, '0.000001')
  `);
  const rows = await db
    .select({ wireProtocol: runUsageRecords.wireProtocol })
    .from(runUsageRecords)
    .where(eq(runUsageRecords.providerResponseId, 'msg_legacy'));
  expect(rows).toEqual([{ wireProtocol: 'anthropic-messages' }]);
}

async function rejectsUnknownWireProtocol(fixture: RunUsageFixture) {
  const { workspaceId, sessionId, repositoryFor } = fixture;
  const { db } = fixture.isolated;
  const rejectedRunId = crypto.randomUUID();
  await db.insert(runs).values({ id: rejectedRunId, workspaceId, sessionId });
  await expect(
    db.execute(sql`
      insert into run_usage_records
        (workspace_id, run_id, provider_response_id, provider, model, input_tokens, output_tokens, cost_usd, wire_protocol)
      values (${workspaceId}, ${rejectedRunId}, 'msg_bad', 'anthropic', 'claude-fixture', 1, 1, '0', 'gemini-generate')
    `),
  ).rejects.toThrow();

  const repository = await repositoryFor(workspaceId);
  await expect(
    repository.recordUsage(rejectedRunId, {
      ...usage('msg_bad_repository'),
      wireProtocol: 'gemini-generate' as unknown as 'anthropic-messages',
    }),
  ).rejects.toThrow(/wire protocol/u);
}

async function roundTripsOpenAiResponses(fixture: RunUsageFixture) {
  const { workspaceId, sessionId, repositoryFor } = fixture;
  const { db } = fixture.isolated;
  const responsesRunId = crypto.randomUUID();
  await db.insert(runs).values({ id: responsesRunId, workspaceId, sessionId });
  const repository = await repositoryFor(workspaceId);
  await expect(
    repository.recordUsage(responsesRunId, {
      ...usage('resp_openai_1'),
      provider: 'openai',
      model: 'gpt-fixture',
      wireProtocol: 'openai-responses',
    }),
  ).resolves.toMatchObject({ kind: 'recorded' });
  const rows = await db
    .select({
      wireProtocol: runUsageRecords.wireProtocol,
      provider: runUsageRecords.provider,
    })
    .from(runUsageRecords)
    .where(eq(runUsageRecords.providerResponseId, 'resp_openai_1'));
  expect(rows).toEqual([{ wireProtocol: 'openai-responses', provider: 'openai' }]);
  await expect(repository.get(responsesRunId)).resolves.toMatchObject({
    accountingState: 'complete',
  });
}

export function registerWireProtocolCases(fixture: RunUsageFixture) {
  it('defaults wire_protocol to anthropic-messages for a row inserted without one', () =>
    defaultsWireProtocol(fixture));

  it('rejects a wire protocol outside the closed set, in SQL and in the repository', () =>
    rejectsUnknownWireProtocol(fixture));

  it('round-trips an openai-responses settlement onto the ledger row', () =>
    roundTripsOpenAiResponses(fixture));
}
