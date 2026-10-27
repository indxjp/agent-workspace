import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import type { BuilderToolCallRepositoryProvider } from '@agent-workspace/core/db';
import { BUILDER_DEFAULT_LIMITS } from '@indx-workspace/contracts/builder';
import { describe, expect, it } from 'vitest';

import { TEST_DOOR } from '../../testing/context';
import type { CallContext } from '../../ports';
import { createAudit } from './store';

const WORKSPACE = '00000000-0000-4000-8000-000000000001';

const ctx: CallContext = {
  workspaceId: WORKSPACE,
  door: TEST_DOOR,
  runId: 'run-1',
  traceId: 'trace-1',
  modelId: 'model-1',
  promptVersion: 'prompt-1',
  caller: { kind: 'none' },
};

/** Records what the store hands the repository, with no database. */
function setup() {
  const written: { inputJson: unknown; resultJson: unknown }[] = [];
  const repositories: BuilderToolCallRepositoryProvider = {
    forScope: () => ({
      record: (call) => {
        written.push({ inputJson: call.inputJson, resultJson: call.resultJson });
        return Promise.resolve(true);
      },
      listForRun: () => Promise.resolve([]),
      findCall: () => Promise.resolve(null),
      listSpentInputs: () => Promise.resolve([]),
    }),
  };
  const audit = createAudit({
    repositories,
    scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]),
  });
  const record = (input: unknown, result: unknown) =>
    audit.record(ctx, {
      callId: 'call-1',
      tool: 'draft_save',
      decision: 'run',
      outcome: 'ok',
      code: null,
      input,
      result,
    });
  return { written, record };
}

describe('the journal bounds what it stores', () => {
  it('stores a marker for an input or result JSON cannot serialise', async () => {
    const { written, record } = setup();
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    await record(cycle, { size: 1n });
    expect(written).toEqual([
      { inputJson: { unserialisable: true }, resultJson: { unserialisable: true } },
    ]);
  });

  it('stores a truncated marker for a result over the tool-output limit', async () => {
    const { written, record } = setup();
    await record({ ok: true }, { text: 'x'.repeat(BUILDER_DEFAULT_LIMITS.toolOutputMaxBytes) });
    expect(written[0]?.inputJson).toEqual({ ok: true });
    expect(written[0]?.resultJson).toMatchObject({ truncated: true });
  });

  it('keeps a small result and stores null for none', async () => {
    const { written, record } = setup();
    await record(undefined, undefined);
    await record({ a: 1 }, { saved: true });
    expect(written).toEqual([
      { inputJson: {}, resultJson: null },
      { inputJson: { a: 1 }, resultJson: { saved: true } },
    ]);
  });
});
