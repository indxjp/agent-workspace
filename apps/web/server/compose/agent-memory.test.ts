import { createInMemoryCatalog } from '@agent-workspace/core/db/unscoped';
import { createInMemoryObjectStore } from '@agent-workspace/core/storage';
import { encodeUstar } from '@agent-workspace/runtime/transfer';
import { describe, expect, it } from 'vitest';

import { AGENT_MEMORY_MAX_BYTES, AGENT_MEMORY_MAX_FILES } from '@indx-workspace/contracts/agents';

import type { LaunchContext } from '../runs/environment';
import { createStorageService } from '../storage/service';
import {
  boundedMemoryWrites,
  isUnderMemoryDirectory,
  memoryUpdatedLabel,
  withMemoryFiles,
} from './agent-memory';
import type { RunFileGrant } from './resource-loader';
import type { RuntimeLaunchTarget } from './runtime-profile';
import { createRuntimeWorkspaceLifecycle } from './workspace-lifecycle';

const file = (path: string, access: 'read' | 'read-write' = 'read'): RunFileGrant => ({
  kind: 'file',
  path,
  access,
  size: 1,
  sha256: 'a'.repeat(64),
});

describe('withMemoryFiles (ADR-0163)', () => {
  it('leaves a run without memory exactly as it was', () => {
    const files = [file('notes/a.md'), file('memory/x.md')];
    expect(withMemoryFiles(files, undefined)).toEqual(files);
  });

  it('puts the memory folder in place of anything else under memory/', () => {
    const memory: RunFileGrant[] = [
      { kind: 'directory', path: 'memory', access: 'read-write' },
      file('memory/MEMORY.md', 'read-write'),
    ];
    expect(
      withMemoryFiles([file('notes/a.md'), file('memory'), file('memory/x.md')], memory),
    ).toEqual([file('notes/a.md'), ...memory]);
  });

  it('judges the directory by whole segments', () => {
    expect(isUnderMemoryDirectory('memory')).toBe(true);
    expect(isUnderMemoryDirectory('memory/a.md')).toBe(true);
    expect(isUnderMemoryDirectory('memoryless/a.md')).toBe(false);
  });
});

describe('boundedMemoryWrites', () => {
  const write = (bytes: number) => ({ key: 'memory/a/x.md', data: new Uint8Array(bytes) });

  it('accepts the bounds exactly', () => {
    expect(
      boundedMemoryWrites(Array.from({ length: AGENT_MEMORY_MAX_FILES }, () => write(1))),
    ).toHaveLength(AGENT_MEMORY_MAX_FILES);
    expect(boundedMemoryWrites([write(AGENT_MEMORY_MAX_BYTES)])).toHaveLength(1);
  });

  it('refuses one file or one byte over, by name', () => {
    expect(() =>
      boundedMemoryWrites(Array.from({ length: AGENT_MEMORY_MAX_FILES + 1 }, () => write(1))),
    ).toThrow(/^memory_limit_exceeded: /u);
    expect(() => boundedMemoryWrites([write(AGENT_MEMORY_MAX_BYTES + 1)])).toThrow(
      /^memory_limit_exceeded: /u,
    );
  });

  it('labels an audit row with the run and counts only', () => {
    expect(memoryUpdatedLabel('run-1', { written: 2, unchanged: 1, bytes: 10 })).toBe(
      'run run-1 · 2 written · 1 unchanged · 10 bytes',
    );
  });
});

describe('the lifecycle promotion target', () => {
  it("refuses any target but the run agent's own memory folder, writing nothing", async () => {
    const workspaceId = '22222222-2222-4222-8222-222222222222';
    const catalog = createInMemoryCatalog().forWorkspace(workspaceId);
    const quietLog = { info() {}, warn() {}, error() {}, child: () => quietLog };
    const storage = createStorageService({
      catalog: () => Promise.resolve(catalog),
      objects: createInMemoryObjectStore(),
      log: quietLog,
    });
    const lifecycle = createRuntimeWorkspaceLifecycle({
      storage,
      granted: () => Promise.resolve({ files: [], skills: [] }),
      resources: { load: () => Promise.reject(new Error('not asked')) },
    });
    const context = {
      run: { id: 'run-1' },
      agent: { id: 'agent-1', workspaceId },
      principal: { workspaceId, ownerPrincipalId: 'owner-1', userId: null, principalId: 'p' },
    } as LaunchContext;
    const archive = encodeUstar([
      { path: 'cwd/memory/MEMORY.md', type: 'file', mode: 0o644, data: Buffer.from('x') },
    ]);
    for (const target of ['memory/agent-2', 'notes', 'memory']) {
      await expect(
        lifecycle.promoteOutputs(context, {} as RuntimeLaunchTarget, archive, {
          base: 'cwd/memory',
          target,
        }),
      ).rejects.toThrow(/own memory folder/u);
    }
    expect((await storage.list({ workspaceId }, 'files', '')).rows).toEqual([]);
  });
});
