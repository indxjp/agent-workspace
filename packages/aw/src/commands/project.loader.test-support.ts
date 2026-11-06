import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { CliIo } from '../io.js';
import { loadProject } from '../project/index.js';
import { agentFile, project, surfaceFile } from './project.fixture.test-support.js';

export function describeProjectLoader(): void {
  const io: CliIo = {
    stdin: () => Promise.resolve(''),
    stdout: () => undefined,
    stderr: () => undefined,
    env: {},
    homeDir: 'C:/nonexistent-home',
    fetch: () => Promise.reject(new Error('no network')),
    isTty: false,
  };

  it('refuses when Node runs with type stripping turned off, naming the version', async () => {
    const root = await project({ 'agents/assistant.ts': agentFile() });
    const load = await loadProject({
      root,
      io,
      signal: new AbortController().signal,
      features: { typescript: false },
    });
    expect(load.agents).toEqual([]);
    expect(load.problems).toEqual([
      {
        file: '.',
        status: null,
        code: 'typescript_unavailable',
        details: [expect.stringContaining(process.version)],
      },
    ]);
  });

  it('kills a file that never finishes loading', async () => {
    const root = await project({
      'agents/assistant.ts': `setInterval(() => undefined, 1000);\nconsole.log('evaluating assistant');\nawait new Promise(() => undefined);\n${agentFile()}`,
    });
    // The loader's timer counts from the fork, so a wall-clock budget raced the child's start on a
    // loaded runner: it fired before the file was announced, naming '.'. Only the parent's
    // setTimeout is faked, and the timeout fires once the file has printed; the loader announces
    // each file, awaiting the send, before it evaluates it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let printed: () => void = () => undefined;
      const evaluating = new Promise<void>((resolve) => {
        printed = resolve;
      });
      const load = loadProject({
        root,
        io: {
          ...io,
          stderr: (text) => {
            if (text.includes('evaluating assistant')) printed();
          },
        },
        signal: new AbortController().signal,
        timeoutMs: 1500,
      });
      await evaluating;
      vi.advanceTimersByTime(1500);
      expect((await load).problems).toMatchObject([
        { file: 'agents/assistant.ts', status: null, code: 'loader_timeout' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names a file whose top-level await never settles, or that exits the loader', async () => {
    const root = await project({
      'agents/a.ts': agentFile('', 'a'),
      'agents/b.ts': `await new Promise(() => undefined);\n${agentFile('', 'b')}`,
    });
    const load = await loadProject({ root, io, signal: new AbortController().signal });
    expect(load.problems).toMatchObject([
      { file: 'agents/b.ts', status: null, code: 'module_unfinished' },
    ]);
    const exits = await project({
      'agents/a.ts': agentFile('', 'a'),
      'surfaces/main.ts': `process.exit(0);\n${surfaceFile('main', 'a')}`,
    });
    const exited = await loadProject({ root: exits, io, signal: new AbortController().signal });
    expect(exited.problems).toMatchObject([
      { file: 'surfaces/main.ts', status: null, code: 'module_unfinished' },
    ]);
  });

  it('ignores declaration files and directories', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'agents/types.d.ts': 'export type X = 1;\n',
    });
    await mkdir(path.join(root, 'agents', 'nested.ts'));
    const load = await loadProject({ root, io, signal: new AbortController().signal });
    expect(load.problems).toEqual([]);
    expect(load.agents.map((agent) => agent.file)).toEqual(['agents/assistant.ts']);
  });
}
