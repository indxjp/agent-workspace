import crypto from 'node:crypto';

import {
  BUILDER_TOOL_CALL_DECISIONS,
  BUILDER_TOOL_CALL_OUTCOMES,
  builderToolCalls,
  createDatabaseBuilderToolCallRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { BUILDER_DEFAULT_LIMITS, type BuilderDecision } from '@indx-workspace/contracts/builder';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import { TEST_DOOR } from '../../testing/context';
import type { JournalRow } from '../../core/facts';
import type { CallContext } from '../../ports';
import { handleToolCall } from '../../shell';
import { makeMemoryPorts } from '../../testing/ports';
import { describeAuditConformance } from './audit.contract';
import { MemoryAudit } from './memory';
import { createAudit } from './store';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe('the journal columns', () => {
  it('hold the same decisions and outcomes as the core', () => {
    expectTypeOf<(typeof BUILDER_TOOL_CALL_DECISIONS)[number]>().toEqualTypeOf<
      BuilderDecision['kind']
    >();
    expectTypeOf<(typeof BUILDER_TOOL_CALL_OUTCOMES)[number]>().toEqualTypeOf<
      JournalRow['outcome']
    >();
  });
});

describeAuditConformance('the memory adapter', () => {
  const port = new MemoryAudit();
  return Promise.resolve({
    port,
    workspaceA: crypto.randomUUID(),
    workspaceB: crypto.randomUUID(),
  });
});

describe.skipIf(!hasDatabase)('AuditPort on PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceA = crypto.randomUUID();
  const workspaceB = crypto.randomUUID();

  const audit = () =>
    createAudit({
      repositories: createDatabaseBuilderToolCallRepositoryProvider(isolated.db),
      scopes: createDatabaseWorkspaceScopeResolver(isolated.db),
    });

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_builder_journal');
    await isolated.db.insert(workspaces).values([
      { id: workspaceA, slug: workspaceA, name: 'A' },
      { id: workspaceB, slug: workspaceB, name: 'B' },
    ]);
  }, 180_000);

  afterAll(async () => isolated.close());

  describeAuditConformance('the PostgreSQL journal', () =>
    Promise.resolve({
      port: audit(),
      workspaceA,
      workspaceB,
    }),
  );

  const ctx: CallContext = {
    workspaceId: workspaceA,
    door: TEST_DOOR,
    runId: 'run-pg-only',
    traceId: 'trace-1',
    modelId: 'model-1',
    promptVersion: 'prompt-1',
    caller: { kind: 'none' },
  };

  it('stores a marker instead of an input over the output limit', async () => {
    await audit().record(ctx, {
      callId: 'big',
      tool: 'draft_save',
      decision: 'run',
      outcome: 'ok',
      code: null,
      input: { text: 'x'.repeat(BUILDER_DEFAULT_LIMITS.toolOutputMaxBytes) },
      result: null,
    });
    const [row] = await isolated.db
      .select()
      .from(builderToolCalls)
      .where(eq(builderToolCalls.callId, 'big'));
    expect(row?.inputJson).toMatchObject({ truncated: true });
  });

  it('journals an unknown tool with a null tool and none of the arguments', async () => {
    await handleToolCall(
      { name: 'agents_delete', arguments: { id: 'secret' }, callId: 'unknown-row' },
      ctx,
      makeMemoryPorts({ audit: audit() }),
    );
    const [row] = await isolated.db
      .select()
      .from(builderToolCalls)
      .where(eq(builderToolCalls.callId, 'unknown-row'));
    expect(row).toMatchObject({
      tool: null,
      decision: 'refuse',
      outcome: 'refused',
      code: 'unknown_tool',
      inputJson: {},
    });
  });

  it('still rejects a tool name that is not null and not on the list', async () => {
    await expect(
      isolated.db.insert(builderToolCalls).values({
        workspaceId: workspaceA,
        runId: 'run-pg-only',
        callId: 'bad-tool',
        tool: 'agents_delete' as never,
        decision: 'refuse',
        outcome: 'refused',
        code: null,
        inputJson: {},
        resultJson: null,
        traceId: 't',
        modelId: 'm',
        promptVersion: 'p',
      }),
    ).rejects.toThrow();
  });

  it('rejects a row whose outcome is outside the known set', async () => {
    await expect(
      isolated.db.insert(builderToolCalls).values({
        workspaceId: workspaceA,
        runId: 'run-pg-only',
        callId: 'bad',
        tool: 'draft_check',
        decision: 'run',
        outcome: 'bogus' as never,
        code: null,
        inputJson: {},
        resultJson: null,
        traceId: 't',
        modelId: 'm',
        promptVersion: 'p',
      }),
    ).rejects.toThrow();
  });

  it('reports a workspace that does not exist', async () => {
    await expect(audit().runCounts({ ...ctx, workspaceId: crypto.randomUUID() })).rejects.toThrow();
  });
});
