import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseArguments } from './args.js';
import { profilesFilePath, resolveConfig } from './config.js';
import { saveStoredCredential } from './credentials.js';
import { saveLocalApiKey } from './local-runtime/local-credentials.js';
import { UsageError } from './io.js';

import { homeWithProfiles, emptyHome, resolve } from './config.fixture.test-support.js';
describe('resolveConfig: the project step (issue #451)', () => {
  const TOKEN = `awu_live_${'A'.repeat(22)}_${'S'.repeat(43)}`;
  const v2 = (port?: number): string =>
    [
      'apiVersion: agentworkspace.dev/v2',
      'kind: Project',
      'name: demo',
      'environments:',
      '  local:',
      '    cloud: local',
      '    identity:',
      '      bootstrapAdmin: admin@localhost.test',
      ...(port === undefined ? [] : [`    port: ${String(port)}`]),
      '',
    ].join('\n');
  const V1 = [
    'apiVersion: agentworkspace.dev/v1',
    'kind: Deployment',
    'cloud: local',
    'storage:',
    '  relational: compose',
    '  objects: compose',
    '  secrets: compose',
    'runtime:',
    '  default: docker',
    'identity:',
    '  bootstrapAdmin: admin@localhost.test',
    '',
  ].join('\n');

  let root: string;
  let projectDefault: string;
  let projectPort: string;
  let projectV1: string;
  let projectBroken: string;
  let noProject: string;
  let homeWithToken: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-config-project-'));
    projectDefault = path.join(root, 'default');
    projectPort = path.join(root, 'port');
    projectV1 = path.join(root, 'v1');
    projectBroken = path.join(root, 'broken');
    noProject = path.join(root, 'none');
    homeWithToken = path.join(root, 'home');
    for (const [directory, text] of [
      [projectDefault, v2()],
      [projectPort, v2(4123)],
      [projectV1, V1],
      [projectBroken, `${v2()}    surprise: true\n`],
    ] as const) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'agent-workspace.yaml'), text);
    }
    await mkdir(noProject, { recursive: true });
    await mkdir(path.dirname(profilesFilePath(homeWithToken)), { recursive: true });
    await writeFile(
      profilesFilePath(homeWithToken),
      JSON.stringify({ default: { url: 'https://default.example.com', apiKeyRef: 'DEFAULT_KEY' } }),
    );
    await saveStoredCredential(homeWithToken, 'http://127.0.0.1:3000', {
      token: TOKEN,
      expiresAt: '2999-01-01T00:00:00.000Z',
      workspaceId: '44444444-4444-4444-8444-444444444444',
      workspaceSlug: 'local',
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function resolveProjectConfig(
    input: Partial<Parameters<typeof resolve>[0]> & { readonly cwd: string },
  ) {
    return resolve({ argv: [], env: {}, homeDir: homeWithProfiles, stdin: '', ...input });
  }

  it('ranks a flag over the environment over the project over the default profile', async () => {
    const key = { AGENT_WORKSPACE_API_KEY: 'env-key' };
    const withUrl = { ...key, AGENT_WORKSPACE_URL: 'https://env.example.com' };
    expect(
      await resolveProjectConfig({
        argv: ['--url', 'https://flag.example.com'],
        env: withUrl,
        cwd: projectDefault,
      }),
    ).toMatchObject({ url: 'https://flag.example.com' });
    expect(await resolveProjectConfig({ env: withUrl, cwd: projectDefault })).toMatchObject({
      url: 'https://env.example.com',
    });
    expect(
      await resolveProjectConfig({
        argv: ['--api-key-stdin'],
        env: key,
        stdin: 'k',
        cwd: projectDefault,
      }),
    ).toMatchObject({ url: 'http://127.0.0.1:3000' });
    expect(await resolveProjectConfig({ env: key, cwd: noProject })).toMatchObject({
      url: 'https://default.example.com',
    });
    // A profile named on the command line still outranks the project.
    expect(
      await resolveProjectConfig({
        argv: ['--profile', 'staging'],
        env: { STAGING_KEY: 's' },
        cwd: projectDefault,
      }),
    ).toMatchObject({ url: 'https://staging.example.com', apiKey: 's' });
  });

  it("honours the project's port and defaults to 3000", async () => {
    const stdin = ['--api-key-stdin'];
    expect(
      (
        await resolveProjectConfig({
          argv: stdin,
          homeDir: emptyHome,
          stdin: 'k',
          cwd: projectPort,
        })
      ).url,
    ).toBe('http://127.0.0.1:4123');
    expect(
      (
        await resolveProjectConfig({
          argv: stdin,
          homeDir: emptyHome,
          stdin: 'k',
          cwd: projectDefault,
        })
      ).url,
    ).toBe('http://127.0.0.1:3000');
  });

  it('takes nothing from a lifted v1 profile, or without a directory', async () => {
    const key = { AGENT_WORKSPACE_API_KEY: 'env-key' };
    expect((await resolveProjectConfig({ env: key, cwd: projectV1 })).url).toBe(
      'https://default.example.com',
    );
    expect((await resolve({ argv: [], env: key, homeDir: homeWithProfiles })).url).toBe(
      'https://default.example.com',
    );
    await expect(
      resolveProjectConfig({ env: key, homeDir: emptyHome, cwd: projectV1 }),
    ).rejects.toThrow(/no control plane URL/u);
  });

  it('refuses a malformed project file with its line and column', async () => {
    const failure = resolveProjectConfig({
      env: { AGENT_WORKSPACE_API_KEY: 'k' },
      homeDir: emptyHome,
      cwd: projectBroken,
    });
    await expect(failure).rejects.toBeInstanceOf(UsageError);
    await expect(failure).rejects.toThrow(/^agent-workspace\.yaml:\d+:\d+: /u);
  });

  it('reads the project file only when every earlier source is empty', async () => {
    const env = { AGENT_WORKSPACE_URL: 'https://env.example.com', AGENT_WORKSPACE_API_KEY: 'k' };
    expect(
      (await resolveProjectConfig({ env: env, homeDir: emptyHome, cwd: projectBroken })).url,
    ).toBe('https://env.example.com');
  });

  it('falls back to the stored sign-in, not another key, when --api-key-stdin reads a blank stdin', async () => {
    // docs/sdk/04-api-specification.md §7.1 documents this order (issue #485).
    const env = {
      AGENT_WORKSPACE_URL: 'http://127.0.0.1:3000',
      AGENT_WORKSPACE_API_KEY: 'env-key',
      DEFAULT_KEY: 'profile-key',
    };
    expect(
      await resolve({ argv: ['--api-key-stdin'], env: env, homeDir: homeWithToken, stdin: ' \n' }),
    ).toMatchObject({
      url: 'http://127.0.0.1:3000',
      apiKey: undefined,
      token: TOKEN,
    });
  });

  it("never sends the default profile's key to the project URL", async () => {
    await expect(
      resolveProjectConfig({ env: { DEFAULT_KEY: 'production-key' }, cwd: projectDefault }),
    ).rejects.toThrow(/no credential for this project's local runtime/u);
    // A key piped on stdin still reaches it.
    expect(
      await resolveProjectConfig({
        argv: ['--api-key-stdin'],
        env: { DEFAULT_KEY: 'production-key' },
        stdin: 'stdin-key\n',
        cwd: projectDefault,
      }),
    ).toMatchObject({ apiKey: 'stdin-key' });
  });

  it('never sends AGENT_WORKSPACE_API_KEY to the project URL', async () => {
    const env = { DEFAULT_KEY: 'production-key', AGENT_WORKSPACE_API_KEY: 'env-production-key' };
    await expect(resolveProjectConfig({ env: env, cwd: projectDefault })).rejects.toThrow(
      /no credential for this project's local runtime/u,
    );
    expect(
      await resolveProjectConfig({ env: env, homeDir: homeWithToken, cwd: projectDefault }),
    ).toMatchObject({
      url: 'http://127.0.0.1:3000',
      apiKey: undefined,
      token: TOKEN,
    });
    // Paired with an explicit URL, the environment key is used as before.
    expect(
      await resolveProjectConfig({
        env: { ...env, AGENT_WORKSPACE_URL: 'https://env.example.com' },
        cwd: projectDefault,
      }),
    ).toMatchObject({ url: 'https://env.example.com', apiKey: 'env-production-key' });
  });

  it('says why AGENT_WORKSPACE_API_KEY is not in force inside a project (BH061-022)', async () => {
    const config = await resolveConfig({
      args: parseArguments([]),
      env: { AGENT_WORKSPACE_API_KEY: 'env-production-key' },
      homeDir: homeWithToken,
      cwd: projectDefault,
      readStdin: () => Promise.resolve(''),
      credentialRequired: true,
    });
    expect(config.credential.kind).toBe('user-token');
    expect(config.notices).toHaveLength(1);
    expect(config.notices[0]).toMatch(
      /AGENT_WORKSPACE_API_KEY is not sent .* set AGENT_WORKSPACE_URL/u,
    );
  });

  it('uses the credential stored for the project URL, not the default profile key', async () => {
    expect(
      await resolveProjectConfig({
        env: { DEFAULT_KEY: 'production-key' },
        homeDir: homeWithToken,
        cwd: projectDefault,
      }),
    ).toMatchObject({ url: 'http://127.0.0.1:3000', apiKey: undefined, token: TOKEN });
  });

  it('resolves the local runtime API key aw dev stored as an api-key credential (S1-21)', async () => {
    const apiKey = `ak_live_${'A'.repeat(22)}_${'S'.repeat(43)}`;
    const homeWithKey = path.join(root, 'home-with-key');
    await saveLocalApiKey(homeWithKey, 'http://127.0.0.1:3000', {
      apiKey,
      expiresAt: '2999-01-01T00:00:00.000Z',
      workspaceId: '44444444-4444-4444-8444-444444444444',
      workspaceSlug: 'local',
    });
    expect(
      await resolveProjectConfig({
        env: { DEFAULT_KEY: 'production-key' },
        homeDir: homeWithKey,
        cwd: projectDefault,
      }),
    ).toEqual({ url: 'http://127.0.0.1:3000', apiKey, token: undefined, timeoutMs: undefined });
    // A key piped with --api-key-stdin still wins over the stored one.
    expect(
      await resolveProjectConfig({
        argv: ['--api-key-stdin'],
        homeDir: homeWithKey,
        stdin: 'stdin-key\n',
        cwd: projectDefault,
      }),
    ).toMatchObject({ apiKey: 'stdin-key' });
  });

  it('keeps the local key when aw login stores a token for the same URL, and falls back to the token once the key expires (S1-21)', async () => {
    const apiKey = `ak_live_${'B'.repeat(22)}_${'S'.repeat(43)}`;
    const entry = {
      workspaceId: '44444444-4444-4444-8444-444444444444',
      workspaceSlug: 'local',
    } as const;
    const home = path.join(root, 'home-with-both');
    await saveLocalApiKey(home, 'http://127.0.0.1:3000', {
      ...entry,
      apiKey,
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    // What `aw login --url http://127.0.0.1:3000` writes: its own slot, in credentials.json.
    await saveStoredCredential(home, 'http://127.0.0.1:3000', {
      ...entry,
      token: TOKEN,
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    expect(await resolveProjectConfig({ homeDir: home, cwd: projectDefault })).toMatchObject({
      apiKey,
      token: undefined,
    });

    const expiredHome = path.join(root, 'home-with-expired-key');
    await saveLocalApiKey(expiredHome, 'http://127.0.0.1:3000', {
      ...entry,
      apiKey,
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    await saveStoredCredential(expiredHome, 'http://127.0.0.1:3000', {
      ...entry,
      token: TOKEN,
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    expect(await resolveProjectConfig({ homeDir: expiredHome, cwd: projectDefault })).toMatchObject(
      {
        apiKey: undefined,
        token: TOKEN,
      },
    );
  });

  it('reaches the port a running aw dev moved to, with its key, and falls back once that aw dev is gone (#730)', async () => {
    const apiKey = `ak_live_${'C'.repeat(22)}_${'S'.repeat(43)}`;
    const home = path.join(root, 'home-moved');
    const cwd = path.join(root, 'moved');
    await mkdir(path.join(cwd, '.aw'), { recursive: true });
    await writeFile(path.join(cwd, 'agent-workspace.yaml'), v2());
    await saveLocalApiKey(home, 'http://127.0.0.1:3001', {
      apiKey,
      expiresAt: '2999-01-01T00:00:00.000Z',
      workspaceId: '44444444-4444-4444-8444-444444444444',
      workspaceSlug: 'local',
    });
    const record = (pid: number) =>
      writeFile(path.join(cwd, '.aw', 'runtime.json'), JSON.stringify({ port: 3001, pid }));

    // This process stands in for the running `aw dev`.
    await record(process.pid);
    expect(
      await resolveProjectConfig({
        env: { DEFAULT_KEY: 'production-key' },
        homeDir: home,
        cwd: cwd,
      }),
    ).toEqual({
      url: 'http://127.0.0.1:3001',
      apiKey,
      token: undefined,
      timeoutMs: undefined,
    });
    // §7.1 is unchanged: an explicit URL still outranks the record.
    expect(
      await resolveProjectConfig({
        argv: ['--url', 'https://x.example.com', '--api-key-stdin'],
        homeDir: home,
        stdin: 'k',
        cwd: cwd,
      }),
    ).toMatchObject({ url: 'https://x.example.com', apiKey: 'k' });

    // A record left by an `aw dev` that was killed: the project file's URL, with the existing error.
    await record(spawnSync(process.execPath, ['-e', '']).pid);
    await expect(
      resolveProjectConfig({
        env: { AGENT_WORKSPACE_API_KEY: 'env-key' },
        homeDir: home,
        cwd: cwd,
      }),
    ).rejects.toThrow("no credential for this project's local runtime (http://127.0.0.1:3000)");
    // A record naming anything but a port is ignored the same way.
    await writeFile(
      path.join(cwd, '.aw', 'runtime.json'),
      JSON.stringify({ url: 'https://evil.example.com', pid: process.pid }),
    );
    await expect(resolveProjectConfig({ homeDir: home, cwd: cwd })).rejects.toThrow(
      '(http://127.0.0.1:3000)',
    );
  });
});
