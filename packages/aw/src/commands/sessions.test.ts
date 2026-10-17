import {
  SessionListResponseSchema,
  SessionResourceSchema,
} from '@indx-workspace/contracts/sessions';
import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, IDS, json, runCli, stdoutJson } from '../testing.js';

const LISTING = { sessions: [FIXTURES.session], projectKey: IDS.workspace, nextCursor: null };

describe('aw sessions', () => {
  it('list prints the sessions as a table and the whole envelope as JSON', async () => {
    const human = await runCli(['sessions', 'list', '--status', 'active'], {
      route: () => json(200, LISTING),
    });
    expect(human.calls[0]?.url.search).toBe('?status=active');
    expect(human.stdout).toContain('claude-sess-1');
    const structured = await runCli(['sessions', 'list', '--json'], {
      route: () => json(200, LISTING),
    });
    expect(SessionListResponseSchema.parse(stdoutJson(structured))).toEqual(LISTING);
  });

  it('list pages with --limit/--cursor and names the next cursor on stderr', async () => {
    const page = await runCli(['sessions', 'list', '--limit', '1', '--cursor', 'c-1'], {
      route: () => json(200, { ...LISTING, nextCursor: 'c-2' }),
    });
    expect(page.calls[0]?.url.search).toBe('?limit=1&cursor=c-1');
    expect(page.stderr).toContain('next page: --cursor c-2');
  });

  it('list --all walks every page, keeping the filter', async () => {
    const later = { ...FIXTURES.session, id: '66666666-6666-4666-8666-666666666666' };
    const all = await runCli(['sessions', 'list', '--all', '--status', 'active', '--json'], {
      route: (request) =>
        request.url.searchParams.get('cursor') === 'c-2'
          ? json(200, { ...LISTING, sessions: [FIXTURES.session] })
          : json(200, { ...LISTING, sessions: [later], nextCursor: 'c-2' }),
    });
    expect(all.calls.map((call) => call.url.search)).toEqual([
      '?status=active',
      '?status=active&cursor=c-2',
    ]);
    expect(SessionResourceSchema.array().parse(stdoutJson(all))).toEqual([later, FIXTURES.session]);
  });

  it('get, rename, archive and restore', async () => {
    const get = await runCli(['sessions', 'get', IDS.session, '--json'], {
      route: () => json(200, { session: FIXTURES.session }),
    });
    expect(SessionResourceSchema.parse(stdoutJson(get))).toEqual(FIXTURES.session);
    const rename = await runCli(['sessions', 'rename', IDS.session, 'Incident 42'], {
      route: () => json(200, { session: { ...FIXTURES.session, title: 'Incident 42' } }),
    });
    expect(rename.calls[0]?.json).toEqual({ title: 'Incident 42' });
    const archive = await runCli(['sessions', 'archive', IDS.session], {
      route: () => json(200, { session: { ...FIXTURES.session, status: 'archived' } }),
    });
    expect(archive.calls[0]?.json).toEqual({ status: 'archived' });
    const restore = await runCli(['sessions', 'restore', IDS.session], {
      route: () => json(200, { session: FIXTURES.session }),
    });
    expect(restore.calls[0]?.json).toEqual({ status: 'active' });
  });

  it('transcript restates --project-key when given', async () => {
    const entries = [
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'a1' },
    ];
    const explicit = await runCli(
      [
        'sessions',
        'transcript',
        'claude-sess-1',
        '--project-key',
        IDS.workspace,
        '--subpath',
        'subagents/agent-1',
      ],
      { route: () => json(200, { entries }) },
    );
    expect(explicit.code).toBe(EXIT_CODE.ok);
    expect(explicit.calls).toHaveLength(1);
    expect(explicit.calls[0]?.url.pathname).toBe('/api/sessions/claude-sess-1/transcript');
    expect(explicit.calls[0]?.url.searchParams.get('projectKey')).toBe(IDS.workspace);
    expect(explicit.calls[0]?.url.searchParams.get('subpath')).toBe('subagents/agent-1');
    expect(explicit.stdout).toBe('{"type":"user","uuid":"u1"}\n{"type":"assistant","uuid":"a1"}\n');
  });

  it('transcript and subkeys issue exactly one request when --project-key is omitted (issue #235, S-21)', async () => {
    const entries = [{ type: 'user', uuid: 'u1' }];
    const transcript = await runCli(['sessions', 'transcript', 'claude-sess-1'], {
      route: () => json(200, { entries }),
    });
    expect(transcript.calls).toHaveLength(1);
    expect(transcript.calls[0]?.url.pathname).toBe('/api/sessions/claude-sess-1/transcript');
    expect(transcript.calls[0]?.url.searchParams.has('projectKey')).toBe(false);

    const subkeys = await runCli(['sessions', 'subkeys', 'claude-sess-1', '--json'], {
      route: () => json(200, { subkeys: ['subagents/agent-1'] }),
    });
    expect(subkeys.calls.map((call) => call.url.pathname)).toEqual([
      '/api/sessions/claude-sess-1/subkeys',
    ]);
    expect(subkeys.calls[0]?.url.searchParams.has('projectKey')).toBe(false);
    expect(stdoutJson(subkeys)).toEqual(['subagents/agent-1']);
  });
});
