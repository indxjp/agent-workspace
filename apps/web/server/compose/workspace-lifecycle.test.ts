import { decodeUstar, encodeUstar } from '@agent-workspace/runtime';
import { createInMemoryObjectStoreProvider } from '@agent-workspace/core/storage';
import { describe, expect, it } from 'vitest';

import type { LaunchContext } from '../runs/environment';
import type { RuntimeLaunchTarget } from './runtime-profile';
import { createRuntimeWorkspaceLifecycle } from './workspace-lifecycle';

const context = {
  run: { id: 'run-1' },
  agent: { id: 'agent-1', workspaceId: 'workspace-1' },
  session: { id: 'session-1', agentId: 'agent-1' },
  principal: { userId: 'user-1', workspaceId: 'workspace-1' },
  prompt: 'work',
} as LaunchContext;

const NO_ASSIGNMENTS = () => Promise.resolve({ files: [], skillIds: [], connectorIds: [] });

const target = {
  driver: 'docker',
  runnerUrl: 'http://runner',
  workspaceRoot: '/workspace',
} as RuntimeLaunchTarget;

describe('createRuntimeWorkspaceLifecycle', () => {
  it('hydrates only the agent resources selected for this run', async () => {
    const objects = createInMemoryObjectStoreProvider();
    const lifecycle = createRuntimeWorkspaceLifecycle({
      objects,
      assignments: NO_ASSIGNMENTS,
      resources: {
        load: () =>
          Promise.resolve({
            files: [
              {
                kind: 'file',
                path: 'notes/input.txt',
                contentBase64: Buffer.from('hello').toString('base64'),
                access: 'read',
              },
              { kind: 'directory', path: 'output', access: 'read-write' },
            ],
            skills: [],
            mcpServers: {},
          }),
      },
    });

    const archive = await lifecycle.inputArchive(context, target);
    expect(archive).not.toBeNull();
    expect(decodeUstar(archive ?? new Uint8Array())).toMatchObject([
      { path: 'notes/input.txt', type: 'file', mode: 0o444 },
      { path: 'output', type: 'directory', mode: 0o755 },
    ]);
  });

  it('validates then promotes runtime outputs and removes its recovery archive', async () => {
    const objects = createInMemoryObjectStoreProvider();
    const lifecycle = createRuntimeWorkspaceLifecycle({
      objects,
      assignments: NO_ASSIGNMENTS,
      resources: {
        load: () => Promise.resolve({ files: [], skills: [], mcpServers: {} }),
      },
    });
    const archive = encodeUstar([
      { path: 'output', type: 'directory', mode: 0o755 },
      {
        path: 'output/result.txt',
        type: 'file',
        mode: 0o644,
        data: Buffer.from('done'),
      },
    ]);

    await lifecycle.promoteOutputs(context, target, archive);

    const store = objects.forWorkspace('workspace-1');
    expect(Buffer.from((await store.get('output/result.txt'))?.body ?? []).toString()).toBe('done');
    expect(await store.get('.runtime-staging/run-1.tar')).toBeNull();
  });

  it('keeps the validated archive when object promotion fails', async () => {
    const backing = createInMemoryObjectStoreProvider();
    const base = backing.forWorkspace('workspace-1');
    const lifecycle = createRuntimeWorkspaceLifecycle({
      objects: {
        forWorkspace: () => ({
          ...base,
          put: (key, input) =>
            key === 'output/result.txt'
              ? Promise.reject(new Error('write interrupted'))
              : base.put(key, input),
        }),
      },
      assignments: NO_ASSIGNMENTS,
      resources: {
        load: () => Promise.resolve({ files: [], skills: [], mcpServers: {} }),
      },
    });
    const archive = encodeUstar([
      { path: 'output/result.txt', type: 'file', mode: 0o644, data: Buffer.from('done') },
    ]);

    await expect(lifecycle.promoteOutputs(context, target, archive)).rejects.toThrow(
      'write interrupted',
    );
    expect(await base.get('.runtime-staging/run-1.tar')).not.toBeNull();
  });
});
