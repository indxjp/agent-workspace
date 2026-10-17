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
});
