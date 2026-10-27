import crypto from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { auditEvents } from '../schema/audit-events.js';
import { memberships } from '../schema/memberships.js';
import { runs } from '../schema/runs.js';
import { runUsageRecords } from '../schema/run-usage-records.js';
import { shareRunCharges } from '../schema/share-run-charges.js';
import { shares } from '../schema/shares.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import {
  createDatabaseRunRepositoryProvider,
  listRunsNeedingAccountingReconciliation,
  listStaleRunIds,
} from './runs.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createDatabaseShareRepositoryProvider } from './shares.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('RunRepository usage settlement', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const unpricedRunId = crypto.randomUUID();
  const failureRunId = crypto.randomUUID();
  const staysPendingRunId = crypto.randomUUID();
  const publicRunId = crypto.randomUUID();
  const secondPublicRunId = crypto.randomUUID();
  const shareId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_run_usage');
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: workspaceId, name: 'Usage' });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.com`, name: 'Owner' });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: principalId,
        workspaceId,
        kind: 'membership',
        membershipId,
      });
    });
    await isolated.db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: 'Usage agent',
      instructions: '',
      ownerPrincipalId: principalId,
      createdBy: userId,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    });
    await isolated.db
      .insert(sessions)
      .values({ id: sessionId, workspaceId, userId, ownerPrincipalId: principalId, agentId });
    await isolated.db.insert(runs).values({ id: runId, workspaceId, sessionId });
    await isolated.db.insert(runs).values({ id: unpricedRunId, workspaceId, sessionId });
    await isolated.db.insert(runs).values({ id: failureRunId, workspaceId, sessionId });
    await isolated.db.insert(runs).values({ id: publicRunId, workspaceId, sessionId });
    await isolated.db.insert(runs).values({ id: secondPublicRunId, workspaceId, sessionId });
    await isolated.db.insert(shares).values({
      id: shareId,
      workspaceId,
      token: `pub_${shareId}`,
      subjectType: 'agent',
      subjectId: agentId,
      subjectLabel: 'Usage agent',
      visibility: 'public',
      mode: 'runnable',
      include: {},
      budgetCapUsd: '0.0002',
      publisherPrincipalId: principalId,
      createdBy: userId,
    });
    // Left untouched by every other test: this is the fixture a "never settled" run in the
    // reconciliation query below.
    await isolated.db.insert(runs).values({ id: staysPendingRunId, workspaceId, sessionId });
  }, 180_000);

  afterAll(async () => isolated.close());

  const usage = (providerResponseId: string) => ({
    providerResponseId,
    provider: 'anthropic' as const,
    model: 'claude-fixture',
    inputTokens: 10,
    outputTokens: 4,
    cacheReadInputTokens: 3,
    cacheCreationInputTokens: 2,
    toolCalls: 1,
    wireProtocol: 'anthropic-messages' as const,
    costUsd: '0.000123',
    costCurrency: 'USD' as const,
    priceTableVersion: 'prices-v1',
  });

  it('settles a provider response exactly once under concurrent retries', async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    const repository = createDatabaseRunRepositoryProvider(isolated.db).forScope(scope);
    const [first, second] = await Promise.all([
      repository.recordUsage(runId, usage('msg_same')),
      repository.recordUsage(runId, usage('msg_same')),
    ]);
    expect([first.kind, second.kind].sort()).toEqual(['duplicate', 'recorded']);
    const run = await repository.get(runId);
    expect(run).toMatchObject({
      provider: 'anthropic',
      model: 'claude-fixture',
      inputTokens: 10,
      outputTokens: 4,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 2,
      toolCalls: 1,
      costUsd: '0.000123',
      costCurrency: 'USD',
      priceTableVersion: 'prices-v1',
      accountingState: 'complete',
      accountingError: null,
    });
  });

  it('rejects the legacy accounting state that made the Runs API unreadable', async () => {
    await expect(
      isolated.db.insert(runs).values({
        id: crypto.randomUUID(),
        workspaceId,
        sessionId,
        accountingState: 'unavailable',
        costUsd: '0.010000',
        priceTableVersion: 'prices-v1',
      }),
    ).rejects.toThrow();
  });

  it('attributes concurrent settlement deltas to a public share exactly once', async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    const shareRepository = createDatabaseShareRepositoryProvider(isolated.db).forScope(scope);
    await expect(shareRepository.linkRun(shareId, publicRunId, new Date())).resolves.toEqual({
      kind: 'linked',
    });
    await expect(shareRepository.linkRun(shareId, secondPublicRunId, new Date())).resolves.toEqual({
      kind: 'linked',
    });
    await expect(shareRepository.linkRun(shareId, publicRunId, new Date())).resolves.toEqual({
      kind: 'existing',
    });

    const repository = createDatabaseRunRepositoryProvider(isolated.db).forScope(scope);
    const firstSettlements = await Promise.all([
      repository.recordUsage(publicRunId, usage('msg_public_a')),
      repository.recordUsage(secondPublicRunId, usage('msg_public_b')),
    ]);
    expect(firstSettlements.every((outcome) => outcome.kind === 'recorded')).toBe(true);

    const duplicateSettlements = await Promise.all([
      repository.recordUsage(publicRunId, usage('msg_public_a')),
      repository.recordUsage(secondPublicRunId, usage('msg_public_b')),
    ]);
    expect(duplicateSettlements.every((outcome) => outcome.kind === 'duplicate')).toBe(true);
    await expect(shareRepository.get(shareId)).resolves.toMatchObject({
      spentUsd: '0.000246',
      stopped: true,
    });
    await expect(
      isolated.db
        .select({ chargedUsd: shareRunCharges.chargedUsd })
        .from(shareRunCharges)
        .where(eq(shareRunCharges.shareId, shareId)),
    ).resolves.toEqual([{ chargedUsd: '0.000123' }, { chargedUsd: '0.000123' }]);
    await expect(
      isolated.db
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(eq(auditEvents.subjectId, shareId)),
    ).resolves.toHaveLength(1);
  });

  it('admits at most three in-flight runs per public share, so concurrent visitors cannot overshoot the cap', async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    const busyShareId = crypto.randomUUID();
    await isolated.db.insert(shares).values({
      id: busyShareId,
      workspaceId,
      token: `pub_${busyShareId}`,
      subjectType: 'agent',
      subjectId: agentId,
      subjectLabel: 'Usage agent',
      visibility: 'public',
      mode: 'runnable',
      include: {},
      budgetCapUsd: '5.0000',
      publisherPrincipalId: principalId,
      createdBy: userId,
    });
    const runIds = Array.from({ length: 4 }, () => crypto.randomUUID());
    for (const id of runIds) await isolated.db.insert(runs).values({ id, workspaceId, sessionId });
    const shareRepository = createDatabaseShareRepositoryProvider(isolated.db).forScope(scope);
    const [first, second, third, fourth] = runIds as [string, string, string, string];
    for (const id of [first, second, third]) {
      await expect(shareRepository.linkRun(busyShareId, id, new Date())).resolves.toEqual({
        kind: 'linked',
      });
    }

    await expect(shareRepository.linkRun(busyShareId, fourth, new Date())).resolves.toEqual({
      kind: 'unavailable',
    });
    const now = new Date();
    await expect(
      shareRepository.reserveVisitorMessage({
        id: busyShareId,
        visitorKey: 'v1_busy_visitor',
        windowStartedAt: new Date(now.getTime() - 3_600_000),
        now,
        limit: 5,
      }),
    ).resolves.toEqual({ kind: 'busy' });

    await isolated.db
      .update(runs)
      .set({ status: 'completed', startedAt: now, endedAt: now })
      .where(eq(runs.id, first));
    await expect(shareRepository.linkRun(busyShareId, fourth, new Date())).resolves.toEqual({
      kind: 'linked',
    });
  });

  it('atomically accumulates distinct responses and refuses mixed price versions', async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    const repository = createDatabaseRunRepositoryProvider(isolated.db).forScope(scope);
    await expect(repository.recordUsage(runId, usage('msg_second'))).resolves.toMatchObject({
      kind: 'recorded',
    });
    await expect(
      repository.recordUsage(runId, {
        ...usage('msg_new_prices'),
        priceTableVersion: 'prices-v2',
      }),
    ).resolves.toEqual({ kind: 'price-version-conflict', existingVersion: 'prices-v1' });
    await expect(repository.get(runId)).resolves.toMatchObject({
      inputTokens: 20,
      outputTokens: 8,
      toolCalls: 2,
      costUsd: '0.000246',
      accountingState: 'complete',
    });
  });

  it('records unpriced usage as unavailable, then a priced late arrival for the same response reconciles it to complete', async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    const repository = createDatabaseRunRepositoryProvider(isolated.db).forScope(scope);

    const unpriced = {
      providerResponseId: 'msg_unpriced',
      provider: 'anthropic' as const,
      model: 'claude-fixture',
      inputTokens: 7,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      toolCalls: 0,
      wireProtocol: 'anthropic-messages' as const,
      costUsd: '0.000000',
      costCurrency: 'USD' as const,
      priceTableVersion: null,
    };
    await expect(repository.recordUsage(unpricedRunId, unpriced)).resolves.toMatchObject({
      kind: 'recorded',
    });
    await expect(repository.get(unpricedRunId)).resolves.toMatchObject({
      inputTokens: 7,
      outputTokens: 5,
      costUsd: '0.000000',
      priceTableVersion: null,
      accountingState: 'unavailable',
      accountingError: null,
    });

    // A price becomes available and the same response is resettled — this is what "re-run
    // reconciliation" means at the repository layer: replay the captured response through
    // settlement now that pricing exists.
    await expect(
      repository.recordUsage(unpricedRunId, {
        ...unpriced,
        costUsd: '0.000042',
        priceTableVersion: 'prices-v1',
      }),
    ).resolves.toMatchObject({ kind: 'recorded' });
    await expect(repository.get(unpricedRunId)).resolves.toMatchObject({
      // Token counts are unchanged — the late arrival prices the existing row, it does not add a
      // second copy of usage that was already captured.
      inputTokens: 7,
      outputTokens: 5,
      costUsd: '0.000042',
      priceTableVersion: 'prices-v1',
      accountingState: 'complete',
    });

    // Replaying the now-priced response again is a genuine duplicate: no further change.
    await expect(
      repository.recordUsage(unpricedRunId, {
        ...unpriced,
        costUsd: '0.000042',
        priceTableVersion: 'prices-v1',
      }),
    ).resolves.toMatchObject({ kind: 'duplicate' });
    await expect(repository.get(unpricedRunId)).resolves.toMatchObject({
      inputTokens: 7,
      costUsd: '0.000042',
    });
  });

  it('marks a run failed only while accounting is still pending, and a real settlement supersedes it', async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    const repository = createDatabaseRunRepositoryProvider(isolated.db).forScope(scope);

    await expect(repository.get(failureRunId)).resolves.toMatchObject({
      accountingState: 'pending',
    });
    await expect(
      repository.markAccountingFailed(failureRunId, 'no authoritative usage fields'),
    ).resolves.toMatchObject({ kind: 'moved' });
    await expect(repository.get(failureRunId)).resolves.toMatchObject({
      accountingState: 'failed',
      accountingError: 'no authoritative usage fields',
    });

    // A second failure while already `failed` (not `pending`) is a no-op: it does not overwrite
    // the first reason, and it must not be mistaken for a fresh transition.
    await expect(
      repository.markAccountingFailed(failureRunId, 'a different reason'),
    ).resolves.toMatchObject({ kind: 'no-op' });
    await expect(repository.get(failureRunId)).resolves.toMatchObject({
      accountingError: 'no authoritative usage fields',
    });

    // A real settlement arriving afterward supersedes the failure mark entirely.
    await expect(
      repository.recordUsage(failureRunId, {
        providerResponseId: 'msg_after_failure',
        provider: 'anthropic',
        model: 'claude-fixture',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        toolCalls: 0,
        wireProtocol: 'anthropic-messages',
        costUsd: '0.000010',
        costCurrency: 'USD',
        priceTableVersion: 'prices-v1',
      }),
    ).resolves.toMatchObject({ kind: 'recorded' });
    await expect(repository.get(failureRunId)).resolves.toMatchObject({
      accountingState: 'complete',
      accountingError: null,
    });

    // And now that the run has real settled usage, a later unrelated failure must not regress it.
    await expect(
      repository.markAccountingFailed(failureRunId, 'a later unrelated failure'),
    ).resolves.toMatchObject({ kind: 'no-op' });
    await expect(repository.get(failureRunId)).resolves.toMatchObject({
      accountingState: 'complete',
      accountingError: null,
    });
  });

  it('defaults wire_protocol to anthropic-messages for a row inserted without one', async () => {
    // The compatibility the migration exists for (ADR-0068): `migrate` runs at container start, so
    // a gateway pod from the previous release keeps inserting rows that name no protocol.
    const legacyRunId = crypto.randomUUID();
    await isolated.db.insert(runs).values({ id: legacyRunId, workspaceId, sessionId });
    await isolated.db.execute(sql`
      insert into run_usage_records
        (workspace_id, run_id, provider_response_id, provider, model, input_tokens, output_tokens, cost_usd)
      values (${workspaceId}, ${legacyRunId}, 'msg_legacy', 'anthropic', 'claude-fixture', 5, 2, '0.000001')
    `);
    const rows = await isolated.db
      .select({ wireProtocol: runUsageRecords.wireProtocol })
      .from(runUsageRecords)
      .where(eq(runUsageRecords.providerResponseId, 'msg_legacy'));
    expect(rows).toEqual([{ wireProtocol: 'anthropic-messages' }]);
  });

  it('rejects a wire protocol outside the closed set, in SQL and in the repository', async () => {
    const rejectedRunId = crypto.randomUUID();
    await isolated.db.insert(runs).values({ id: rejectedRunId, workspaceId, sessionId });
    await expect(
      isolated.db.execute(sql`
        insert into run_usage_records
          (workspace_id, run_id, provider_response_id, provider, model, input_tokens, output_tokens, cost_usd, wire_protocol)
        values (${workspaceId}, ${rejectedRunId}, 'msg_bad', 'anthropic', 'claude-fixture', 1, 1, '0', 'gemini-generate')
      `),
    ).rejects.toThrow();

    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    const repository = createDatabaseRunRepositoryProvider(isolated.db).forScope(scope);
    await expect(
      repository.recordUsage(rejectedRunId, {
        ...usage('msg_bad_repository'),
        wireProtocol: 'gemini-generate' as unknown as 'anthropic-messages',
      }),
    ).rejects.toThrow(/wire protocol/u);
  });

  it('round-trips an openai-responses settlement onto the ledger row', async () => {
    const responsesRunId = crypto.randomUUID();
    await isolated.db.insert(runs).values({ id: responsesRunId, workspaceId, sessionId });
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    const repository = createDatabaseRunRepositoryProvider(isolated.db).forScope(scope);
    await expect(
      repository.recordUsage(responsesRunId, {
        ...usage('resp_openai_1'),
        provider: 'openai',
        model: 'gpt-fixture',
        wireProtocol: 'openai-responses',
      }),
    ).resolves.toMatchObject({ kind: 'recorded' });
    const rows = await isolated.db
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
  });

  it("sums the workspace's ledger cost over a half-open window, and says whether any run in it is unpriced", async () => {
    const otherWorkspaceId = crypto.randomUUID();
    const otherMembershipId = crypto.randomUUID();
    const otherPrincipalId = crypto.randomUUID();
    const otherAgentId = crypto.randomUUID();
    const otherSessionId = crypto.randomUUID();
    const otherRunId = crypto.randomUUID();
    await isolated.db
      .insert(workspaces)
      .values({ id: otherWorkspaceId, slug: otherWorkspaceId, name: 'Other' });
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: otherMembershipId, workspaceId: otherWorkspaceId, userId, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: otherPrincipalId,
        workspaceId: otherWorkspaceId,
        kind: 'membership',
        membershipId: otherMembershipId,
      });
    });
    await isolated.db.insert(agents).values({
      id: otherAgentId,
      workspaceId: otherWorkspaceId,
      name: 'Other agent',
      instructions: '',
      ownerPrincipalId: otherPrincipalId,
      createdBy: userId,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    });
    await isolated.db.insert(sessions).values({
      id: otherSessionId,
      workspaceId: otherWorkspaceId,
      userId,
      ownerPrincipalId: otherPrincipalId,
      agentId: otherAgentId,
    });
    await isolated.db
      .insert(runs)
      .values({ id: otherRunId, workspaceId: otherWorkspaceId, sessionId: otherSessionId });

    const row = (
      workspace: string,
      run: string,
      responseId: string,
      costUsd: string,
      createdAt: string,
    ) => ({
      workspaceId: workspace,
      runId: run,
      providerResponseId: responseId,
      provider: 'anthropic',
      model: 'claude-fixture',
      inputTokens: 1,
      outputTokens: 1,
      costUsd,
      createdAt: new Date(createdAt),
    });
    // Two runs of this test's own, so their accounting state does not depend on the other tests:
    // one settled (`complete`, so priced) and one whose response had no price (`unavailable`).
    const pricedRunId = crypto.randomUUID();
    const unavailableRunId = crypto.randomUUID();
    await isolated.db.insert(runs).values({
      id: pricedRunId,
      workspaceId,
      sessionId,
      accountingState: 'complete',
      priceTableVersion: 'test-prices',
    });
    await isolated.db
      .insert(runs)
      .values({ id: unavailableRunId, workspaceId, sessionId, accountingState: 'unavailable' });
    // A window in 2001 that no other test in this file writes to.
    await isolated.db
      .insert(runUsageRecords)
      .values([
        row(workspaceId, pricedRunId, 'day-before', '9', '2001-01-01T23:59:59.999Z'),
        row(workspaceId, pricedRunId, 'day-start', '1.5', '2001-01-02T00:00:00.000Z'),
        row(workspaceId, pricedRunId, 'day-late', '2.25', '2001-01-02T23:59:59.999Z'),
        row(workspaceId, unavailableRunId, 'day-after', '0', '2001-01-03T00:00:00.000Z'),
        row(otherWorkspaceId, otherRunId, 'other-day', '40', '2001-01-02T12:00:00.000Z'),
      ]);

    const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
    const scope = await scopes.forWorkspaceId(workspaceId);
    const otherScope = await scopes.forWorkspaceId(otherWorkspaceId);
    if (scope === null || otherScope === null) throw new Error('workspace did not resolve');
    const provider = createDatabaseRunRepositoryProvider(isolated.db);
    const window = (day: string) =>
      [
        new Date(`2001-01-${day}T00:00:00Z`),
        new Date(`2001-01-0${Number(day) + 1}T00:00:00Z`),
      ] as const;

    // The settled run's day: the rows before and after it are outside the half-open window.
    await expect(provider.forScope(scope).usageCostUsd(...window('02'))).resolves.toEqual({
      costUsd: '3.750000',
      unpricedUsage: false,
    });
    // The next day holds only the unpriced run's row: cost 0, and flagged as not measurable.
    await expect(provider.forScope(scope).usageCostUsd(...window('03'))).resolves.toEqual({
      costUsd: '0.000000',
      unpricedUsage: true,
    });
    // The other workspace's run is still `pending` (not complete), and never leaks into ours.
    await expect(provider.forScope(otherScope).usageCostUsd(...window('02'))).resolves.toEqual({
      costUsd: '40.000000',
      unpricedUsage: true,
    });
    await expect(
      provider
        .forScope(scope)
        .usageCostUsd(new Date('2001-02-01T00:00:00Z'), new Date('2001-02-02T00:00:00Z')),
    ).resolves.toEqual({ costUsd: '0', unpricedUsage: false });
  });

  it('lists non-complete runs older than a threshold for operator reconciliation', async () => {
    const future = new Date(Date.now() + 60_000);
    const candidates = await listRunsNeedingAccountingReconciliation(isolated.db, future, 1_000);
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));

    // Never settled by any other test in this file — must be surfaced as needing reconciliation.
    expect(byId.get(staysPendingRunId)).toMatchObject({
      workspaceId,
      accountingState: 'pending',
      accountingError: null,
    });
    // Reached `complete` in the tests above — must not appear; a query that widens past
    // `accounting_state <> 'complete'` would send an operator chasing runs that are already fine.
    expect(byId.has(runId)).toBe(false);

    // A threshold in the past excludes every run in this fixture (all created "now").
    const none = await listRunsNeedingAccountingReconciliation(
      isolated.db,
      new Date(Date.now() - 60_000),
      1_000,
    );
    expect(none.some((candidate) => candidate.id === staysPendingRunId)).toBe(false);
  });

  it('lists runs left running or queued since before a cutoff for the stale-run sweep', async () => {
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
    const orphanedRunning = crypto.randomUUID();
    const orphanedQueued = crypto.randomUUID();
    const live = crypto.randomUUID();
    const finished = crypto.randomUUID();
    await isolated.db.insert(runs).values([
      { id: orphanedRunning, workspaceId, sessionId, status: 'running', startedAt: hoursAgo(2) },
      { id: orphanedQueued, workspaceId, sessionId, createdAt: hoursAgo(2) },
      // Created long ago but started recently: alive by its start, not its creation.
      {
        id: live,
        workspaceId,
        sessionId,
        status: 'running',
        createdAt: hoursAgo(2),
        startedAt: new Date(),
      },
      {
        id: finished,
        workspaceId,
        sessionId,
        status: 'completed',
        createdAt: hoursAgo(2),
        startedAt: hoursAgo(2),
        endedAt: hoursAgo(2),
      },
    ]);
    const stale = await listStaleRunIds(isolated.db, hoursAgo(1), 1_000);
    expect(stale).toContain(orphanedRunning);
    expect(stale).toContain(orphanedQueued);
    expect(stale).not.toContain(live);
    expect(stale).not.toContain(finished);
  });
});
