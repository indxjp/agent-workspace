import { CONTRACTS_VERSION } from '@indx-workspace/contracts';
import { describe, expect, it } from 'vitest';

import {
  ADMIN_ID,
  harness,
  projectDir,
  TOKEN,
  URL_,
  WORKSPACE,
  WORKSPACE_ID,
} from './launcher.test-support.js';
import { localDatabaseUrl, signInLine } from './local-launcher.js';
describe('runLocalLauncher — protocol', () => {
  it('sends ready and then credential, in that order, with the seeded workspace', async () => {
    const h = harness();
    await expect(h.run()).resolves.toBe(0);
    expect(h.sent).toStrictEqual([
      { type: 'ready', url: URL_, contractsVersion: CONTRACTS_VERSION },
      {
        type: 'credential',
        token: TOKEN,
        expiresAt: '2026-10-03T00:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        workspaceSlug: 'default',
      },
    ]);
    expect(h.events).toStrictEqual([
      `chdir:${projectDir}`,
      'startWorkspace:/runtime/dist/web',
      'claimSignals',
      'send:ready',
      'resolveMembership:dev@localhost.test:default',
      // S1-22: the `local` profile is the workspace default before any key exists.
      `prepareProfile:${WORKSPACE_ID}:directory`,
      // The subject only: the issuer reads the member's role from the directory itself.
      `issue:${WORKSPACE_ID}:${ADMIN_ID}:2:directory`,
      'send:credential',
    ]);
    expect(h.env['AW_DEPLOYMENT_POSTURE']).toBe('local');
    expect(h.env['SESSION_SECRET']).toMatch(/^[0-9a-f]{64}$/u);
  });

  // Issue #1506: `aw dev` migrates and runs a generated app on the workspace's own database.
  it('names the database the workspace runs on in ready, when it is a loopback PostgreSQL', async () => {
    const databaseUrl =
      'postgresql://agent_workspace:agent_workspace_local@127.0.0.1:25432/postgres';
    const h = harness({
      startWorkspace: () => {
        h.env['DATABASE_URL'] = databaseUrl;
        return Promise.resolve({ ...WORKSPACE, close: () => Promise.resolve() });
      },
    });
    await expect(h.run()).resolves.toBe(0);
    expect(h.sent[0]).toStrictEqual({
      type: 'ready',
      url: URL_,
      contractsVersion: CONTRACTS_VERSION,
      databaseUrl,
    });
  });

  it('names no database in ready when the workspace runs on a remote DATABASE_URL', async () => {
    const h = harness();
    h.env['DATABASE_URL'] = 'postgresql://app:secret@db.example.com:5432/agent_workspace';
    await expect(h.run()).resolves.toBe(0);
    expect(h.sent[0]).toStrictEqual({
      type: 'ready',
      url: URL_,
      contractsVersion: CONTRACTS_VERSION,
    });
  });

  it('localDatabaseUrl keeps only a loopback postgres url', () => {
    expect(localDatabaseUrl({})).toBeUndefined();
    expect(localDatabaseUrl({ DATABASE_URL: 'postgres://u:p@localhost:5432/x' })).toBe(
      'postgres://u:p@localhost:5432/x',
    );
    expect(localDatabaseUrl({ DATABASE_URL: 'postgres://u:p@10.0.0.1:5432/x' })).toBeUndefined();
  });
});

describe('signInLine', () => {
  it('points at the environment when the password did not come from the file', () => {
    const line = signInLine(URL_, 'dev@localhost.test', {
      path: '/p/local-secrets.json',
      passwordFromFile: false,
    });
    expect(line).toContain('set in the environment or .env');
  });
});
