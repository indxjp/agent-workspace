import { canonicalCall } from '@indx-workspace/contracts/agents';
import { DEMO_RECORD_SAMPLES } from '@indx-workspace/contracts/demo-operator';
import { describe, expect, it, vi } from 'vitest';

import { RECORDS_JSON_MAX_BYTES } from '../provision/limits';
import { recordsServerCommand } from '../provision/records-server';
import { createDemoApprovedWrites } from './approved-writes';

const TASK = DEMO_RECORD_SAMPLES.task.en;
const CALL = {
  canonicalCall: canonicalCall('mcp__tasks__task_create', TASK),
};

/**
 * One workspace holding the `tasks` stand-in made from `notes` (and, when given, `others` before
 * it), with `update` answering `outcome`.
 */
function storeWith(
  notes: string,
  outcome: 'updated' | 'not-found',
  others: readonly Record<string, unknown>[] = [],
) {
  const { command, args } = recordsServerCommand({
    reads: ['task_list'],
    writes: ['task_create'],
    sets: [{ lang: 'en', tools: ['task_list'], data: [{ notes }] }],
    recorded: [{ write: 'task_create', kind: 'task', read: 'task_list' }],
  });
  const update = vi.fn(() => Promise.resolve({ kind: outcome }));
  const list = vi.fn(() =>
    Promise.resolve([...others, { id: 'c1', name: 'tasks', transport: 'stdio', command, args }]),
  );
  const forWorkspace = vi.fn(() => ({ list, update }));
  return { connectors: { forWorkspace } as never, forWorkspace, list, update, args };
}

const demo = () => Promise.resolve(true);

describe('the approved-writes keeper', () => {
  it('keeps the approved call in the stand-in it names', async () => {
    const { connectors, update } = storeWith('short', 'updated');
    await createDemoApprovedWrites({ connectors, keepsDemoWrites: demo }).keep({
      workspaceId: 'w1',
      calls: [CALL],
    });
    expect(update).toHaveBeenCalledOnce();
  });

  it('reads nothing for a workspace that is not a demo workspace', async () => {
    const { connectors, forWorkspace, update } = storeWith('short', 'updated');
    const keepsDemoWrites = vi.fn(() => Promise.resolve(false));
    await createDemoApprovedWrites({ connectors, keepsDemoWrites }).keep({
      workspaceId: 'w1',
      calls: [CALL],
    });
    expect(keepsDemoWrites).toHaveBeenCalledWith('w1');
    expect(forWorkspace).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('asks nothing at all when no call was approved', async () => {
    const { connectors, forWorkspace } = storeWith('short', 'updated');
    const keepsDemoWrites = vi.fn(demo);
    await createDemoApprovedWrites({ connectors, keepsDemoWrites }).keep({
      workspaceId: 'w1',
      calls: [],
    });
    expect(keepsDemoWrites).not.toHaveBeenCalled();
    expect(forWorkspace).not.toHaveBeenCalled();
  });

  it('skips a call that is not JSON, not an MCP tool, or names a tool connector', async () => {
    const tool = { id: 'c2', name: 'orders', kind: 'openapi', transport: null };
    const { connectors, update } = storeWith('short', 'updated', [tool]);
    await createDemoApprovedWrites({ connectors, keepsDemoWrites: demo }).keep({
      workspaceId: 'w1',
      calls: [
        { canonicalCall: 'not json' },
        { canonicalCall: canonicalCall('Write', { file_path: 'x' }) },
        { canonicalCall: canonicalCall('mcp__orders__order_create', TASK) },
        { canonicalCall: canonicalCall('mcp__nobody__task_create', TASK) },
      ],
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps nothing more once the stand-in would not fit one process', async () => {
    // Padded to just under the bound: the sample fits, the kept call (about 300 bytes) would not.
    const [, , ...pieces] = storeWith('', 'updated').args;
    const room = RECORDS_JSON_MAX_BYTES - Buffer.byteLength(pieces.join(''), 'utf8');
    const { connectors, update } = storeWith('x'.repeat(room - 50), 'updated');
    await createDemoApprovedWrites({ connectors, keepsDemoWrites: demo }).keep({
      workspaceId: 'w1',
      calls: [CALL],
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('fails when the row it read is gone before it is written, so the run API logs it', async () => {
    const { connectors, update } = storeWith('short', 'not-found');
    await expect(
      createDemoApprovedWrites({ connectors, keepsDemoWrites: demo }).keep({
        workspaceId: 'w1',
        calls: [CALL],
      }),
    ).rejects.toThrow('was not updated: not-found');
    expect(update).toHaveBeenCalledOnce();
  });
});
