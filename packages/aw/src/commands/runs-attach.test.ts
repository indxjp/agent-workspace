/**
 * `aw runs start --attach <file>` (the storage design, §07, US-STO-06 on the CLI): each value is a
 * workspace file id, or a workspace path resolved to its id from the parent folder's listing, and
 * the run is started with them as `attachments`, which the server grants read-only. A file the
 * caller may not read is the server's concealed `404 file_not_found`, printed as the error.
 */
// @story US-STO-06
import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { IDS, json, runCli, runFixture, type Route } from '../testing.js';

const BY_ID = 'a0000000-0000-4000-8000-000000000001';
const BY_PATH = 'a0000000-0000-4000-8000-000000000002';

const entry = (id: string, path: string) => ({
  id,
  path,
  kind: 'file',
  sizeBytes: 17,
  contentType: 'text/plain',
  lastModified: '2026-09-21T10:00:00.000Z',
});

/** `GET /api/files?path=reports` lists `reports/q3.txt`; a start answers `started`. */
const routes =
  (started: () => Response): Route =>
  (request) => {
    if (request.method === 'GET' && request.url.pathname === '/api/files') {
      const folder = request.url.searchParams.get('path');
      return json(200, { files: folder === 'reports' ? [entry(BY_PATH, 'reports/q3.txt')] : [] });
    }
    return started();
  };

const queued = () =>
  json(202, { run: runFixture('queued'), events: `/api/runs/${IDS.run}/events` });

describe('aw runs start --attach', () => {
  it('[US-STO-06][api][cli] aw runs start --attach delivers the file read-only', async () => {
    const run = await runCli(
      [
        'runs',
        'start',
        IDS.agent,
        '--prompt',
        'Summarise',
        '--attach',
        BY_ID,
        '--attach',
        'reports/q3.txt',
        '--json',
      ],
      { route: routes(queued) },
    );
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    const start = run.calls.find((call) => call.method === 'POST');
    expect(start?.url.pathname).toBe(`/api/agents/${IDS.agent}/runs`);
    // An attachment carries no access: the server grants every attachment `read` (ADR-0146).
    expect(start?.json).toEqual({
      prompt: 'Summarise',
      sessionId: null,
      modelConnectionId: null,
      model: null,
      attachments: [{ fileId: BY_ID }, { fileId: BY_PATH }],
    });
  });

  it('[US-STO-06][api][cli] a file the caller may not read prints 404 file_not_found and exits non-zero', async () => {
    const run = await runCli(['runs', 'start', IDS.agent, '--prompt', 'x', '--attach', BY_ID], {
      route: routes(() =>
        json(404, { error: { code: 'file_not_found', message: 'no file has that id.' } }),
      ),
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toBe('error: file_not_found: no file has that id.\n');
  });

  it('refuses a path with no file before starting anything', async () => {
    const run = await runCli(
      ['runs', 'start', IDS.agent, '--prompt', 'x', '--attach', 'reports/missing.txt'],
      { route: routes(queued) },
    );
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--attach reports/missing.txt');
    expect(run.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it.each(['./reports/q3.txt', '/reports/q3.txt'])(
    'reads %s as the workspace path reports/q3.txt',
    async (given) => {
      const run = await runCli(['runs', 'start', IDS.agent, '--prompt', 'x', '--attach', given], {
        route: routes(queued),
      });
      expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
      const start = run.calls.find((call) => call.method === 'POST');
      expect(start?.json).toMatchObject({ attachments: [{ fileId: BY_PATH }] });
    },
  );

  it('refuses a path with a .. segment before calling the server', async () => {
    const run = await runCli(
      ['runs', 'start', IDS.agent, '--prompt', 'x', '--attach', 'reports/../q3.txt'],
      { route: routes(queued) },
    );
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--attach reports/../q3.txt');
    expect(run.calls).toEqual([]);
  });

  it('sends no attachments without --attach', async () => {
    const run = await runCli(['runs', 'start', IDS.agent, '--prompt', 'x'], {
      route: routes(queued),
    });
    expect(run.calls[0]?.json).not.toHaveProperty('attachments');
  });
});
