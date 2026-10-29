import { FEATURE_IDS } from '@indx-workspace/contracts/features';
import { SharingPolicySchema } from '@indx-workspace/contracts/workspaces';
import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { IDS, json, runCli, stdoutJson } from '../testing.js';

const WORKSPACE = {
  id: IDS.workspace,
  slug: 'acme',
  name: 'Acme',
  publicSharingEnabled: false,
  archivedAt: null,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
  role: 'owner',
};

describe('aw workspaces', () => {
  it('sharing-policy get and set', async () => {
    const get = await runCli(['workspaces', 'sharing-policy', 'get', '--json'], {
      route: () => json(200, { publicSharing: true }),
    });
    expect(SharingPolicySchema.parse(stdoutJson(get))).toEqual({ publicSharing: true });
    const set = await runCli(['workspaces', 'sharing-policy', 'set', 'false'], {
      route: () => json(200, { publicSharing: false }),
    });
    expect(set.calls[0]?.method).toBe('PATCH');
    expect(set.calls[0]?.json).toEqual({ publicSharing: false });
    expect(set.stdout).toBe('publicSharing  false\n');
    const bad = await runCli(['workspaces', 'sharing-policy', 'set', 'maybe']);
    expect(bad.code).toBe(EXIT_CODE.usage);
  });

  it('lists, gets, creates and updates workspaces as the signed-in person', async () => {
    const list = await runCli(['workspaces', 'list', '--json'], {
      route: () => json(200, { workspaces: [WORKSPACE] }),
    });
    expect(list.code).toBe(EXIT_CODE.ok);
    expect(list.calls[0]?.url.pathname).toBe('/api/workspaces');
    expect(stdoutJson(list)).toEqual([WORKSPACE]);

    const get = await runCli(['workspaces', 'get', IDS.workspace], {
      route: () => json(200, { workspace: WORKSPACE }),
    });
    expect(get.calls[0]?.url.pathname).toBe(`/api/workspaces/${IDS.workspace}`);

    const create = await runCli(['workspaces', 'create', '--name', 'Acme', '--slug', 'acme'], {
      route: () => json(201, { workspace: WORKSPACE }),
    });
    expect(create.calls[0]?.json).toEqual({ name: 'Acme', slug: 'acme' });

    const update = await runCli(['workspaces', 'update', IDS.workspace, '--archived', 'true'], {
      route: () => json(200, { workspace: { ...WORKSPACE, role: undefined } }),
    });
    expect(update.calls[0]?.method).toBe('PATCH');
    expect(update.calls[0]?.json).toEqual({ archived: true });
  });

  it('answers an API key with the server’s 403 api_key_not_permitted (ADR W9-WS-119)', async () => {
    const run = await runCli(['workspaces', 'list'], {
      route: () =>
        json(403, {
          error: { code: 'api_key_not_permitted', message: 'API keys cannot list workspaces.' },
        }),
    });
    expect(run.calls[0]?.headers.get('authorization')).toBe('Bearer ak_live_test');
    expect(run.code).not.toBe(EXIT_CODE.ok);
    expect(run.stderr).toContain('api_key_not_permitted');
  });

  describe('features (ADR-0160 D6–D8)', () => {
    const rows = (off: readonly string[]) => ({
      features: FEATURE_IDS.map((id) => ({ id, installed: true, enabled: !off.includes(id) })),
    });

    it('lists every feature with what it needs', async () => {
      const run = await runCli(['workspaces', 'features', 'list', '--workspace', IDS.workspace], {
        route: () => json(200, rows(['files'])),
      });
      expect(run.code).toBe(EXIT_CODE.ok);
      expect(run.calls[0]?.url.pathname).toBe(`/api/workspaces/${IDS.workspace}/features`);
      expect(run.stdout).toMatch(/surfaces\s+true\s+true\s+chat/u);
      expect(run.stdout).toMatch(/files\s+true\s+false/u);
    });

    it('disable sends the whole off set and prints the changed row', async () => {
      const run = await runCli(
        ['workspaces', 'features', 'disable', 'files', '--workspace', IDS.workspace, '--json'],
        { route: (request) => json(200, rows(request.method === 'PUT' ? ['files'] : [])) },
      );
      expect(run.code).toBe(EXIT_CODE.ok);
      expect(run.calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
      expect(run.calls[1]?.json).toEqual({ disabled: ['files'] });
      expect(stdoutJson(run)).toMatchObject([{ id: 'files', installed: true, enabled: false }]);
    });

    describe('on a deployment that does not install `builder`', () => {
      const narrowed = (off: readonly string[]) => ({
        features: FEATURE_IDS.map((id) =>
          id === 'builder'
            ? { id, installed: false, enabled: false }
            : { id, installed: true, enabled: !off.includes(id) },
        ),
      });

      it('disable of an installed feature keeps the uninstalled one in the off set', async () => {
        const run = await runCli(
          ['workspaces', 'features', 'disable', 'files', '--workspace', IDS.workspace],
          { route: (request) => json(200, narrowed(request.method === 'PUT' ? ['files'] : [])) },
        );
        expect(run.code).toBe(EXIT_CODE.ok);
        expect(run.calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
        expect(run.calls[1]?.json).toEqual({ disabled: ['builder', 'files'] });
      });

      it('enable of an installed feature keeps the uninstalled one in the off set', async () => {
        const run = await runCli(
          ['workspaces', 'features', 'enable', 'files', '--workspace', IDS.workspace],
          { route: (request) => json(200, narrowed(request.method === 'PUT' ? [] : ['files'])) },
        );
        expect(run.code).toBe(EXIT_CODE.ok);
        expect(run.calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
        expect(run.calls[1]?.json).toEqual({ disabled: ['builder'] });
      });
    });

    it('enable removes only that feature from the off set', async () => {
      const run = await runCli(
        ['workspaces', 'features', 'enable', 'files', '--workspace', IDS.workspace],
        {
          route: (request) =>
            json(200, rows(request.method === 'PUT' ? ['evaluations'] : ['files', 'evaluations'])),
        },
      );
      expect(run.code).toBe(EXIT_CODE.ok);
      expect(run.calls[1]?.json).toEqual({ disabled: ['evaluations'] });
    });

    it('defaults --workspace to the caller’s own workspace from /api/me', async () => {
      const run = await runCli(['workspaces', 'features', 'list'], {
        route: (request) =>
          request.url.pathname === '/api/me'
            ? json(200, {
                principalId: IDS.workspace,
                kind: 'membership',
                role: 'owner',
                workspaceId: IDS.workspace,
                userId: IDS.workspace,
                label: 'Ada',
                features: FEATURE_IDS,
              })
            : json(200, rows([])),
      });
      expect(run.code).toBe(EXIT_CODE.ok);
      expect(run.calls.map((call) => call.url.pathname)).toEqual([
        '/api/me',
        `/api/workspaces/${IDS.workspace}/features`,
      ]);
    });

    it('refuses an unknown feature id before any request', async () => {
      const run = await runCli([
        'workspaces',
        'features',
        'disable',
        'telepathy',
        '--workspace',
        IDS.workspace,
      ]);
      expect(run.code).toBe(EXIT_CODE.usage);
      expect(run.calls).toHaveLength(0);
      expect(run.stderr).toContain('must be one of');
    });

    it('names feature_in_use and the dependent when the server refuses', async () => {
      const run = await runCli(
        ['workspaces', 'features', 'disable', 'chat', '--workspace', IDS.workspace],
        {
          route: (request) =>
            request.method === 'PUT'
              ? json(409, {
                  error: {
                    code: 'feature_in_use',
                    message: 'in use',
                    details: ['feature:surfaces'],
                  },
                })
              : json(200, rows([])),
        },
      );
      expect(run.code).not.toBe(EXIT_CODE.ok);
      expect(run.stderr).toContain('feature_in_use');
      expect(run.stderr).toContain('surfaces');
    });
  });
});
