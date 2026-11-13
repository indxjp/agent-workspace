vi.mock('@indx-workspace/sdk/portable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@indx-workspace/sdk/portable')>();
  return { ...actual, diffBodies: vi.fn(actual.diffBodies) };
});
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { json, runCli, type Route } from '../testing.js';
import {
  ARGV,
  MESSAGE,
  SAVE,
  bodyOf,
  call,
  answered,
  SAVED,
  ask,
  decisions,
  project,
} from './agents-new.fixture.test-support.js';

describe('Builder save decisions', () => {
  it.each([
    ['neither stdin nor stdout is a terminal', { isTty: false, stdinIsTty: false }],
    ['stdout is a terminal but stdin is piped', { isTty: true, stdinIsTty: false }],
    ['stdin is a terminal but stdout is redirected', { isTty: false, stdinIsTty: true }],
  ])('[US-BLD-06][api][cli] refuses before any request when %s', async (_name, tty) => {
    const route: Route = () => {
      throw new Error('the command must not reach the network');
    };
    const run = await runCli(ARGV, { ...tty, route, prompt: () => Promise.resolve('y') });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain(MESSAGE);
    expect(run.calls).toEqual([]);
  });

  it('[US-BLD-06][api][cli] y saves once and exports files that pass aw check', async () => {
    const out = await project();
    const body = bodyOf('Refund politely.');
    const { run, asked } = await ask(call('draft_save', { body }), ['y'], {
      out,
      after: answered(SAVED),
      versions: [body],
    });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(asked).toEqual([SAVE]);
    expect(run.stdout).toContain('Save a new agent named "summariser":');
    expect(decisions(run)).toEqual([{ decision: 'approve' }]);
    expect(await readFile(path.join(out, 'agents', 'summariser.md'), 'utf8')).toBe(
      'Refund politely.',
    );
    const checked = await runCli(['check'], {
      cwd: out,
      route: ({ method, url }) =>
        method === 'POST'
          ? json(200, { ok: true, number: 1 })
          : json(200, url.pathname === '/api/agents' ? { agents: [] } : { connectors: [] }),
    });
    expect(checked.stderr).toBe('');
    expect(checked.code).toBe(EXIT_CODE.ok);
  });

  it.each(['n', '', 'yes', 'Maybe'])(
    '[US-BLD-06][api][cli] %j saves nothing and writes no files',
    async (answer) => {
      const out = await project();
      const { run } = await ask(call('draft_save', { body: bodyOf('x') }), [answer], { out });
      expect(run.code).toBe(EXIT_CODE.ok);
      expect(decisions(run)).toEqual([{ decision: 'reject' }]);
      expect(run.stdout).toContain('No draft was saved.');
      expect(run.calls.some((request) => request.url.pathname.endsWith('/versions'))).toBe(false);
      expect(await readdir(out)).toEqual(['agent-workspace.yaml']);
    },
  );
});
