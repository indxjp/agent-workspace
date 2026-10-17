import { chmod, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { credentialsFilePath } from '../credentials.js';
import { EXIT_CODE } from '../output.js';
import { IDS, json, runCli, stdoutJson, tempDirectory, type Route } from '../testing.js';

const URL_ENV = { AGENT_WORKSPACE_URL: 'https://aw.example.com' };
const TOKEN = `awu_live_${'A'.repeat(22)}_${'S'.repeat(43)}`;
const DEVICE = {
  deviceCode: 'v1.BCDFGHJK.9999999999.signature',
  userCode: 'BCDF-GHJK',
  verificationPath: '/api/auth/cli-verify',
  expiresInSeconds: 600,
  intervalSeconds: 5,
};
const WORKSPACE = {
  id: IDS.workspace,
  slug: 'acme',
  name: 'Acme',
  publicSharingEnabled: false,
  archivedAt: null,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
  role: 'admin',
};
const FAR_FUTURE = '2999-01-01T00:00:00.000Z';

const pollProblem = (code: string) => json(400, { error: { code, message: code } });

/** A device flow that answers `answers` to the polls in order, then issues the token. */
function deviceFlow(answers: readonly string[]): Route {
  let polls = 0;
  return (request) => {
    if (request.url.pathname === '/api/auth/cli-device') return json(200, DEVICE);
    if (request.url.pathname === '/api/auth/cli-token' && request.method === 'POST') {
      const answer = answers[polls];
      polls += 1;
      return answer === undefined
        ? json(200, { token: TOKEN, expiresAt: FAR_FUTURE, workspace: WORKSPACE })
        : pollProblem(answer);
    }
    if (request.url.pathname === '/api/auth/cli-token' && request.method === 'DELETE') {
      return json(204, null);
    }
    if (request.url.pathname === '/api/workspaces') return json(200, { workspaces: [WORKSPACE] });
    if (request.url.pathname === '/api/auth/cli-workspace') {
      return json(200, { workspace: { ...WORKSPACE, id: IDS.project, slug: 'other' } });
    }
    return json(404, { error: { code: 'not_found', message: 'no route' } });
  };
}

describe('aw login / logout (issue #242)', () => {
  let home: string;

  beforeAll(async () => {
    home = await tempDirectory();
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('signs in through the device flow, never printing the token, and stores it', async () => {
    const run = await runCli(['login', '--json'], {
      isTty: true,
      env: URL_ENV,
      homeDir: home,
      route: deviceFlow(['authorization_pending', 'slow_down', 'authorization_pending']),
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    // No credential is presented to the pre-authentication routes.
    for (const call of run.calls) expect(call.headers.get('authorization')).toBeNull();
    expect(run.calls.map((call) => call.url.pathname)).toEqual([
      '/api/auth/cli-device',
      '/api/auth/cli-token',
      '/api/auth/cli-token',
      '/api/auth/cli-token',
      '/api/auth/cli-token',
    ]);
    expect(run.calls[1]?.json).toEqual({ deviceCode: DEVICE.deviceCode });
    expect(run.stderr).toContain('https://aw.example.com/api/auth/cli-verify?code=BCDF-GHJK');
    // The secret scan: the token is in neither stream, including under --json.
    expect(run.stdout).not.toContain('awu_live_');
    expect(run.stderr).not.toContain('awu_live_');
    expect(stdoutJson(run)).toEqual({ workspace: WORKSPACE, expiresAt: FAR_FUTURE });
    const stored = JSON.parse(await readFile(credentialsFilePath(home), 'utf8')) as unknown;
    expect(stored).toEqual({
      'https://aw.example.com': {
        token: TOKEN,
        expiresAt: FAR_FUTURE,
        workspaceId: WORKSPACE.id,
        workspaceSlug: 'acme',
      },
    });
  });

  // POSIX permission bits do not exist on Windows (`stat().mode` reports 0o666 whatever was
  // asked), so this is asserted where it means something — every CI runner.
  it.skipIf(process.platform === 'win32')('stores the token owner-only (0600)', async () => {
    expect((await stat(credentialsFilePath(home))).mode % 0o1000).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')(
    'tightens an existing, wider config directory to 0700',
    async () => {
      const fresh = await tempDirectory();
      try {
        const directory = path.dirname(credentialsFilePath(fresh));
        await mkdir(directory, { recursive: true, mode: 0o755 });
        await chmod(directory, 0o755);
        const run = await runCli(['login'], {
          isTty: true,
          env: URL_ENV,
          homeDir: fresh,
          route: deviceFlow([]),
        });
        expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
        expect((await stat(directory)).mode % 0o1000).toBe(0o700);
      } finally {
        await rm(fresh, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['no terminal', { isTty: false }],
    ['CI=true', { isTty: false, env: { ...URL_ENV, CI: 'true' } }],
  ])('exits 1 at once, polling nothing, with %s', async (_name, options) => {
    const fresh = await tempDirectory();
    try {
      const started = Date.now();
      const run = await runCli(['login'], {
        env: URL_ENV,
        homeDir: fresh,
        route: deviceFlow([]),
        ...options,
      });
      expect(run.code).toBe(EXIT_CODE.problem);
      expect(run.stderr).toContain(
        'fix: set AGENT_WORKSPACE_API_KEY (aw login needs a person at a browser)',
      );
      expect(run.calls).toHaveLength(0);
      expect(Date.now() - started).toBeLessThan(2000);
      await expect(stat(credentialsFilePath(fresh))).rejects.toThrow();
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it('uses the stored token as the person for the workspace commands', async () => {
    const list = await runCli(['workspaces', 'list'], {
      env: URL_ENV,
      homeDir: home,
      route: deviceFlow([]),
    });
    expect(list.code, list.stderr).toBe(EXIT_CODE.ok);
    expect(list.calls[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('prefers a configured API key, so signing in never changes what automation acts as', async () => {
    const run = await runCli(['workspaces', 'list'], {
      env: { ...URL_ENV, AGENT_WORKSPACE_API_KEY: 'ak_live_test' },
      homeDir: home,
      route: deviceFlow([]),
    });
    expect(run.calls[0]?.headers.get('authorization')).toBe('Bearer ak_live_test');
  });

  it('switches workspace by moving the token, and records the move', async () => {
    const run = await runCli(['workspaces', 'select', 'other'], {
      env: URL_ENV,
      homeDir: home,
      route: deviceFlow([]),
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.url.pathname).toBe('/api/auth/cli-workspace');
    expect(run.calls[0]?.json).toEqual({ workspace: 'other' });
    const stored = JSON.parse(await readFile(credentialsFilePath(home), 'utf8')) as Record<
      string,
      { readonly workspaceSlug: string }
    >;
    expect(stored['https://aw.example.com']?.workspaceSlug).toBe('other');
  });

  it('signs out by revoking the token on the server, then forgets it', async () => {
    const run = await runCli(['logout', '--json'], {
      env: URL_ENV,
      homeDir: home,
      route: deviceFlow([]),
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.method).toBe('DELETE');
    expect(run.calls[0]?.url.pathname).toBe('/api/auth/cli-token');
    expect(run.calls[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(stdoutJson(run)).toEqual({ signedOut: true, revoked: true });
    await expect(stat(credentialsFilePath(home))).rejects.toThrow();
    const after = await runCli(['workspaces', 'list'], { env: URL_ENV, homeDir: home });
    expect(after.code).toBe(EXIT_CODE.usage);
    expect(after.stderr).toContain('aw login');
  });

  it.each([
    ['access_denied', 'the person denied the code'],
    ['expired_token', 'the device code expired'],
  ])('stops and stores nothing when the poll answers %s (%s)', async (code) => {
    const fresh = await tempDirectory();
    try {
      const run = await runCli(['login'], {
        isTty: true,
        env: URL_ENV,
        homeDir: fresh,
        route: deviceFlow(['authorization_pending', code]),
      });
      expect(run.code).not.toBe(EXIT_CODE.ok);
      expect(run.stderr).toContain(code);
      expect(run.calls).toHaveLength(3);
      await expect(stat(credentialsFilePath(fresh))).rejects.toThrow();
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});
