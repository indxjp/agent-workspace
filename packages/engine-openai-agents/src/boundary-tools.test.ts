import { readFileSync } from 'node:fs';

import path from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import {
  MCP_FIXTURE,
  memoryStore,
  gateway,
  workspace,
  requestFor,
  run,
  toolFrames,
} from './boundary.fixture.test-support.js';

describe('SDK tools and session resume', () => {
  it('calls an assigned stdio connector and reports it as an mcp tool call', async () => {
    const cwd = workspace({});
    gateway.script([{ call: { name: 'echo', args: { text: 'hi' } } }, { text: 'Echoed.' }]);

    const frames = await run(
      requestFor(
        cwd,
        'openai-responses',
        {},
        {
          mcpServers: { echo: { type: 'stdio', command: process.execPath, args: [MCP_FIXTURE] } },
        },
      ),
    );

    expect(toolFrames(frames)).toEqual([
      { frame: 'agent.tool.call', name: 'echo', kind: 'mcp' },
      {
        frame: 'agent.tool.result',
        isError: false,
        output: expect.stringContaining('echo: hi') as unknown,
      },
    ]);
  });

  it('refuses a write under a read-only grant in the Editor and leaves the file unchanged', async () => {
    const cwd = workspace({ 'docs/spec.md': 'original\n' });
    gateway.script([
      {
        call: {
          name: 'apply_patch',
          args: {
            type: 'update_file',
            path: 'docs/spec.md',
            diff: '@@\n-original\n+changed\n',
            moveTo: null,
          },
        },
      },
      { text: 'Could not.' },
    ]);

    const frames = await run(
      requestFor(cwd, 'openai-responses', {
        resources: { files: [{ kind: 'directory', path: 'docs', access: 'read' }], skills: [] },
      }),
    );

    const result = frames.find((frame) => frame.frame === 'agent.tool.result');
    expect(result).toMatchObject({ isError: true });
    expect(readFileSync(path.join(cwd, 'docs/spec.md'), 'utf8')).toBe('original\n');
    // `shell` is withheld while a read-only grant exists (ADR-0074 D2).
    const tools = (gateway.requests[0]?.body['tools'] as { name: string }[]).map(
      (tool) => tool.name,
    );
    expect(tools).not.toContain('shell');
  });

  it('resumes a session: the second run sees the first run’s items', async () => {
    const cwd = workspace({});
    const store = memoryStore();
    gateway.script([{ text: 'First answer.' }]);
    await run(requestFor(cwd, 'openai-responses', { prompt: 'remember the word teal' }), store);
    expect(store.entries().length).toBeGreaterThan(0);

    gateway.script([{ text: 'Second answer.' }]);
    await run(
      requestFor(cwd, 'openai-responses', {
        prompt: 'which word?',
        session: { mode: 'resume', engineSessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e' },
      }),
      store,
    );

    const input = JSON.stringify(gateway.requests[0]?.body['input']);
    expect(input).toContain('remember the word teal');
    expect(input).toContain('First answer.');
    expect(input).toContain('which word?');
  });
});
