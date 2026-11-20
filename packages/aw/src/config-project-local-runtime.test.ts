import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { saveStoredCredential } from './credentials.js';
import {
  FAR_FUTURE,
  fixtures,
  LOCAL_ENTRY,
  LOCAL_URL,
  resolveProjectConfig,
  TOKEN,
  v2,
} from './config-project.test-support.js';
import { saveLocalApiKey } from './local-runtime/local-credentials.js';

const liveKey = (letter: string): string => `ak_live_${letter.repeat(22)}_${'S'.repeat(43)}`;

describe('resolveConfig: the local runtime credentials of a project', () => {
  it('resolves the local runtime API key aw dev stored as an api-key credential (S1-21)', async () => {
    const apiKey = liveKey('A');
    const homeWithKey = path.join(fixtures.root, 'home-with-key');
    await saveLocalApiKey(homeWithKey, LOCAL_URL, {
      ...LOCAL_ENTRY,
      apiKey,
      expiresAt: FAR_FUTURE,
    });
    expect(
      await resolveProjectConfig({
        env: { DEFAULT_KEY: 'production-key' },
        homeDir: homeWithKey,
        cwd: fixtures.projectDefault,
      }),
    ).toEqual({ url: LOCAL_URL, apiKey, token: undefined, timeoutMs: undefined });
    // A key piped with --api-key-stdin still wins over the stored one.
    expect(
      await resolveProjectConfig({
        argv: ['--api-key-stdin'],
        homeDir: homeWithKey,
        stdin: 'stdin-key\n',
        cwd: fixtures.projectDefault,
      }),
    ).toMatchObject({ apiKey: 'stdin-key' });
  });

  /** A home holding both a local API key (with the given expiry) and an `aw login` token. */
  async function homeWithKeyAndToken(
    name: string,
    apiKey: string,
    keyExpiresAt: string,
  ): Promise<string> {
    const home = path.join(fixtures.root, name);
    await saveLocalApiKey(home, LOCAL_URL, { ...LOCAL_ENTRY, apiKey, expiresAt: keyExpiresAt });
    // What `aw login --url http://127.0.0.1:3000` writes: its own slot, in credentials.json.
    await saveStoredCredential(home, LOCAL_URL, {
      ...LOCAL_ENTRY,
      token: TOKEN,
      expiresAt: FAR_FUTURE,
    });
    return home;
  }

  it('keeps the local key when aw login stores a token for the same URL, and falls back to the token once the key expires (S1-21)', async () => {
    const apiKey = liveKey('B');
    const home = await homeWithKeyAndToken('home-with-both', apiKey, FAR_FUTURE);
    expect(
      await resolveProjectConfig({ homeDir: home, cwd: fixtures.projectDefault }),
    ).toMatchObject({ apiKey, token: undefined });

    const expiredHome = await homeWithKeyAndToken(
      'home-with-expired-key',
      apiKey,
      '2000-01-01T00:00:00.000Z',
    );
    expect(
      await resolveProjectConfig({ homeDir: expiredHome, cwd: fixtures.projectDefault }),
    ).toMatchObject({ apiKey: undefined, token: TOKEN });
  });

  it('reaches the port a running aw dev moved to, with its key, and falls back once that aw dev is gone (#730)', async () => {
    const apiKey = liveKey('C');
    const home = path.join(fixtures.root, 'home-moved');
    const cwd = path.join(fixtures.root, 'moved');
    await mkdir(path.join(cwd, '.aw'), { recursive: true });
    await writeFile(path.join(cwd, 'agent-workspace.yaml'), v2());
    await saveLocalApiKey(home, 'http://127.0.0.1:3001', {
      ...LOCAL_ENTRY,
      apiKey,
      expiresAt: FAR_FUTURE,
    });
    const writeRecord = (record: object) =>
      writeFile(path.join(cwd, '.aw', 'runtime.json'), JSON.stringify(record));
    const NO_CREDENTIAL = "no credential for this project's local runtime";

    // This process stands in for the running `aw dev`.
    await writeRecord({ port: 3001, pid: process.pid });
    expect(
      await resolveProjectConfig({ env: { DEFAULT_KEY: 'production-key' }, homeDir: home, cwd }),
    ).toEqual({ url: 'http://127.0.0.1:3001', apiKey, token: undefined, timeoutMs: undefined });
    // §7.1 is unchanged: an explicit URL still outranks the record.
    expect(
      await resolveProjectConfig({
        argv: ['--url', 'https://x.example.com', '--api-key-stdin'],
        homeDir: home,
        stdin: 'k',
        cwd,
      }),
    ).toMatchObject({ url: 'https://x.example.com', apiKey: 'k' });

    // A record left by an `aw dev` that was killed: the project file's URL, with the existing error.
    await writeRecord({ port: 3001, pid: spawnSync(process.execPath, ['-e', '']).pid });
    await expect(
      resolveProjectConfig({ env: { AGENT_WORKSPACE_API_KEY: 'env-key' }, homeDir: home, cwd }),
    ).rejects.toThrow(`${NO_CREDENTIAL} (${LOCAL_URL})`);
    // A record naming anything but a port is ignored the same way.
    await writeRecord({ url: 'https://evil.example.com', pid: process.pid });
    await expect(resolveProjectConfig({ homeDir: home, cwd })).rejects.toThrow(`(${LOCAL_URL})`);
  });
});
