vi.mock('@indx-workspace/sdk/portable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@indx-workspace/sdk/portable')>();
  return { ...actual, diffBodies: vi.fn(actual.diffBodies) };
});
import { readdir } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { eventStream, IDS, json, runCli, runFixture, tempFile } from '../testing.js';
import {
  ARGV,
  TERMINAL,
  BUILDER,
  bodyOf,
  status,
  DONE,
  message,
  call,
  answered,
  SAVED,
  ask,
  project,
} from './agents-new.fixture.test-support.js';

describe('Builder chat and export', () => {
  it('keeps the session across the chat turns and ends on an empty line', async () => {
    const starts: unknown[] = [];
    const answers = ['then add a wiki tool', ''];
    const run = await runCli(ARGV, {
      ...TERMINAL,
      prompt: () => Promise.resolve(answers.shift() ?? ''),
      route: (request) => {
        if (request.url.pathname === '/api/agents') return json(200, { agents: [BUILDER] });
        if (request.method === 'POST') {
          starts.push(request.json);
          return json(202, { run: runFixture('queued'), events: `/api/runs/${IDS.run}/events` });
        }
        if (request.url.pathname.endsWith('/events')) {
          return eventStream(message('Which wiki?') + status(2, 'completed') + DONE);
        }
        return json(200, { run: runFixture('completed') });
      },
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toContain('Which wiki?');
    expect(run.stdout).toContain('No draft was saved.');
    expect(starts).toMatchObject([
      { prompt: 'Build a refunds helper', sessionId: null },
      { prompt: 'then add a wiki tool', sessionId: IDS.session },
    ]);
  });

  it('reports the saved version when the run fails after the save', async () => {
    const out = await project();
    const body = bodyOf('a');
    const { run } = await ask(call('draft_save', { body }), ['y'], {
      out,
      after: answered(SAVED, 'failed'),
      ended: 'failed',
      error: 'boom',
      versions: [body],
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toContain(
      `Saved agent ${IDS.agent} as version 1.\nWrite it as code with: ` +
        `aw agents export ${IDS.agent} --format ts --agent-version 1 --out ${JSON.stringify(out)}\n`,
    );
    expect(run.stderr).toContain('failed: boom\n');
    expect(await readdir(out)).toEqual(['agent-workspace.yaml']);
  });

  it('keeps --out and suggests --force when the export would overwrite files', async () => {
    const out = await project();
    await tempFile(out, 'agents/summariser.md', 'mine');
    const body = bodyOf('a');
    const script = { out, after: answered(SAVED), versions: [body] };
    const { run } = await ask(call('draft_save', { body }), ['y'], script);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('refusing to overwrite');
    expect(run.stderr).toContain(
      `aw agents export ${IDS.agent} --format ts --agent-version 1 --out ${JSON.stringify(out)} --force`,
    );
  });
});
