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

let homeWithProfiles: string;
let homeWithBrokenProfiles: string;
let emptyHome: string;

beforeAll(async () => {
  homeWithProfiles = await mkdtemp(path.join(tmpdir(), 'aw-config-'));
  homeWithBrokenProfiles = await mkdtemp(path.join(tmpdir(), 'aw-config-broken-'));
  emptyHome = await mkdtemp(path.join(tmpdir(), 'aw-config-empty-'));
  for (const [home, text] of [
    [
      homeWithProfiles,
      JSON.stringify({
        default: { url: 'https://default.example.com', apiKeyRef: 'DEFAULT_KEY' },
        staging: { url: 'https://staging.example.com', apiKeyRef: 'STAGING_KEY' },
      }),
    ],
    [homeWithBrokenProfiles, '{ "default": { "url": "x", "apiKey": "in-the-file" } }'],
  ] as const) {
    const file = profilesFilePath(home);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
});

afterAll(async () => {
  for (const home of [homeWithProfiles, homeWithBrokenProfiles, emptyHome]) {
    await rm(home, { recursive: true, force: true });
  }
});

/** The resolved config, with an API-key credential flattened to `apiKey` for the assertions below. */
async function resolve(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
  stdin = '',
  cwd?: string,
) {
  const config = await resolveConfig({
    args: parseArguments(argv),
    env,
    homeDir,
    cwd,
    readStdin: () => Promise.resolve(stdin),
    credentialRequired: true,
  });
  return {
    url: config.url,
    timeoutMs: config.timeoutMs,
    apiKey: config.credential.kind === 'api-key' ? config.credential.apiKey : undefined,
    token: config.credential.kind === 'user-token' ? config.credential.token : undefined,
  };
}

describe('resolveConfig', () => {
  it('takes the flag over the environment over the profile, field by field', async () => {
    const env = {
      AGENT_WORKSPACE_URL: 'https://env.example.com',
      AGENT_WORKSPACE_API_KEY: 'env-key',
      DEFAULT_KEY: 'from-profile-ref',
    };
    expect(await resolve(['--url', 'https://flag.example.com'], env, homeWithProfiles)).toEqual({
      url: 'https://flag.example.com',
      apiKey: 'env-key',
      token: undefined,
      timeoutMs: undefined,
    });
    expect(await resolve([], env, homeWithProfiles)).toMatchObject({
      url: 'https://env.example.com',
      apiKey: 'env-key',
    });
    expect(await resolve([], { DEFAULT_KEY: 'k' }, homeWithProfiles)).toMatchObject({
      url: 'https://default.example.com',
      apiKey: 'k',
    });
  });

  it("never sends the default profile's key to another URL", async () => {
    const env = { DEFAULT_KEY: 'production-key' };
    await expect(
      resolve(['--url', 'https://elsewhere.example.com'], env, homeWithProfiles),
    ).rejects.toThrow(/no credential: run `aw login`/u);
    await expect(
      resolve(
        [],
        { ...env, AGENT_WORKSPACE_URL: 'https://elsewhere.example.com/' },
        homeWithProfiles,
      ),
    ).rejects.toThrow(/no credential: run `aw login`/u);
    // The same URL, spelled with a trailing slash, is still the profile's own.
    expect(
      await resolve(['--url', 'https://default.example.com/'], env, homeWithProfiles),
    ).toMatchObject({ apiKey: 'production-key' });
  });

  it('warns when a credential is about to travel over plain http to another host', async () => {
    const notices = async (url: string) =>
      (
        await resolveConfig({
          args: parseArguments(['--url', url]),
          env: { AGENT_WORKSPACE_API_KEY: 'k' },
          homeDir: emptyHome,
          cwd: undefined,
          readStdin: () => Promise.resolve(''),
          credentialRequired: true,
        })
      ).notices;
    expect(await notices('http://aw.example.com')).toEqual([
      'http://aw.example.com is plain http to a host that is not this machine; the credential travels unencrypted',
    ]);
    expect(await notices('http://127.0.0.1:3000')).toEqual([]);
    expect(await notices('https://aw.example.com')).toEqual([]);
  });

  it('reads the key from stdin with --api-key-stdin, ahead of the environment', async () => {
    const config = await resolve(
      ['--api-key-stdin'],
      { AGENT_WORKSPACE_URL: 'https://env.example.com', AGENT_WORKSPACE_API_KEY: 'env-key' },
      emptyHome,
      'ak_live_from_stdin\n',
    );
    expect(config.apiKey).toBe('ak_live_from_stdin');
  });

  it('selects a named profile and refuses an unknown one', async () => {
    expect(
      await resolve(['--profile', 'staging'], { STAGING_KEY: 's' }, homeWithProfiles),
    ).toMatchObject({
      url: 'https://staging.example.com',
      apiKey: 's',
    });
    await expect(resolve(['--profile', 'prod'], {}, homeWithProfiles)).rejects.toThrow(
      'profile "prod" is not defined',
    );
  });

  it('ranks a profile named with --profile above the environment, and the default one below it', async () => {
    // A shell that exports the production pair must not send the production key to staging.
    const env = {
      AGENT_WORKSPACE_URL: 'https://env.example.com',
      AGENT_WORKSPACE_API_KEY: 'env-key',
      STAGING_KEY: 's',
    };
    expect(await resolve(['--profile', 'staging'], env, homeWithProfiles)).toMatchObject({
      url: 'https://staging.example.com',
      apiKey: 's',
    });
    // Still field by field: a flag beats the named profile, and an unset apiKeyRef falls back.
    expect(
      await resolve(
        ['--profile', 'staging', '--url', 'https://flag.example.com'],
        env,
        homeWithProfiles,
      ),
    ).toMatchObject({ url: 'https://flag.example.com', apiKey: 's' });
    expect(
      await resolve(
        ['--profile', 'staging'],
        { AGENT_WORKSPACE_API_KEY: 'env-key' },
        homeWithProfiles,
      ),
    ).toMatchObject({ url: 'https://staging.example.com', apiKey: 'env-key' });
    // Without --profile the implicit default stays below the environment, as before.
    expect(await resolve([], env, homeWithProfiles)).toMatchObject({
      url: 'https://env.example.com',
      apiKey: 'env-key',
    });
  });

  it('explains a missing URL and a missing key as usage errors', async () => {
    await expect(resolve([], {}, emptyHome)).rejects.toThrow(/no control plane URL/u);
    await expect(resolve(['--url', 'https://x.example.com'], {}, emptyHome)).rejects.toThrow(
      /no credential: run `aw login`/u,
    );
    await expect(resolve([], { DEFAULT_KEY: '' }, homeWithProfiles)).rejects.toBeInstanceOf(
      UsageError,
    );
  });

  it('refuses a profiles file that carries anything but url and apiKeyRef', async () => {
    await expect(resolve([], {}, homeWithBrokenProfiles)).rejects.toThrow(/malformed/u);
  });

  it('parses --timeout as positive milliseconds', async () => {
    const env = { AGENT_WORKSPACE_URL: 'https://x', AGENT_WORKSPACE_API_KEY: 'k' };
    expect((await resolve(['--timeout', '2500'], env, emptyHome)).timeoutMs).toBe(2500);
    await expect(resolve(['--timeout', 'soon'], env, emptyHome)).rejects.toThrow(/--timeout/u);
  });
});

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

  it('ranks a flag over the environment over the project over the default profile', async () => {
    const key = { AGENT_WORKSPACE_API_KEY: 'env-key' };
    const withUrl = { ...key, AGENT_WORKSPACE_URL: 'https://env.example.com' };
    expect(
      await resolve(
        ['--url', 'https://flag.example.com'],
        withUrl,
        homeWithProfiles,
        '',
        projectDefault,
      ),
    ).toMatchObject({ url: 'https://flag.example.com' });
    expect(await resolve([], withUrl, homeWithProfiles, '', projectDefault)).toMatchObject({
      url: 'https://env.example.com',
    });
    expect(
      await resolve(['--api-key-stdin'], key, homeWithProfiles, 'k', projectDefault),
    ).toMatchObject({ url: 'http://127.0.0.1:3000' });
    expect(await resolve([], key, homeWithProfiles, '', noProject)).toMatchObject({
      url: 'https://default.example.com',
    });
    // A profile named on the command line still outranks the project.
    expect(
      await resolve(
        ['--profile', 'staging'],
        { STAGING_KEY: 's' },
        homeWithProfiles,
        '',
        projectDefault,
      ),
    ).toMatchObject({ url: 'https://staging.example.com', apiKey: 's' });
  });

  it("honours the project's port and defaults to 3000", async () => {
    const stdin = ['--api-key-stdin'];
    expect((await resolve(stdin, {}, emptyHome, 'k', projectPort)).url).toBe(
      'http://127.0.0.1:4123',
    );
    expect((await resolve(stdin, {}, emptyHome, 'k', projectDefault)).url).toBe(
      'http://127.0.0.1:3000',
    );
  });

  it('takes nothing from a lifted v1 profile, or without a directory', async () => {
    const key = { AGENT_WORKSPACE_API_KEY: 'env-key' };
    expect((await resolve([], key, homeWithProfiles, '', projectV1)).url).toBe(
      'https://default.example.com',
    );
    expect((await resolve([], key, homeWithProfiles)).url).toBe('https://default.example.com');
    await expect(resolve([], key, emptyHome, '', projectV1)).rejects.toThrow(
      /no control plane URL/u,
    );
  });

  it('refuses a malformed project file with its line and column', async () => {
    const failure = resolve([], { AGENT_WORKSPACE_API_KEY: 'k' }, emptyHome, '', projectBroken);
    await expect(failure).rejects.toBeInstanceOf(UsageError);
    await expect(failure).rejects.toThrow(/^agent-workspace\.yaml:\d+:\d+: /u);
  });

  it('reads the project file only when every earlier source is empty', async () => {
    const env = { AGENT_WORKSPACE_URL: 'https://env.example.com', AGENT_WORKSPACE_API_KEY: 'k' };
    expect((await resolve([], env, emptyHome, '', projectBroken)).url).toBe(
      'https://env.example.com',
    );
  });

  it('falls back to the stored sign-in, not another key, when --api-key-stdin reads a blank stdin', async () => {
    // docs/sdk/04-api-specification.md §7.1 documents this order (issue #485).
    const env = {
      AGENT_WORKSPACE_URL: 'http://127.0.0.1:3000',
      AGENT_WORKSPACE_API_KEY: 'env-key',
      DEFAULT_KEY: 'profile-key',
    };
    expect(await resolve(['--api-key-stdin'], env, homeWithToken, ' \n')).toMatchObject({
      url: 'http://127.0.0.1:3000',
      apiKey: undefined,
      token: TOKEN,
    });
  });

  it("never sends the default profile's key to the project URL", async () => {
    await expect(
      resolve([], { DEFAULT_KEY: 'production-key' }, homeWithProfiles, '', projectDefault),
    ).rejects.toThrow(/no credential for this project's local runtime/u);
    // A key piped on stdin still reaches it.
    expect(
      await resolve(
        ['--api-key-stdin'],
        { DEFAULT_KEY: 'production-key' },
        homeWithProfiles,
        'stdin-key\n',
        projectDefault,
      ),
    ).toMatchObject({ apiKey: 'stdin-key' });
  });

  it('never sends AGENT_WORKSPACE_API_KEY to the project URL', async () => {
    const env = { DEFAULT_KEY: 'production-key', AGENT_WORKSPACE_API_KEY: 'env-production-key' };
    await expect(resolve([], env, homeWithProfiles, '', projectDefault)).rejects.toThrow(
      /no credential for this project's local runtime/u,
    );
    expect(await resolve([], env, homeWithToken, '', projectDefault)).toMatchObject({
      url: 'http://127.0.0.1:3000',
      apiKey: undefined,
      token: TOKEN,
    });
    // Paired with an explicit URL, the environment key is used as before.
    expect(
      await resolve(
        [],
        { ...env, AGENT_WORKSPACE_URL: 'https://env.example.com' },
        homeWithProfiles,
        '',
        projectDefault,
      ),
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
      await resolve([], { DEFAULT_KEY: 'production-key' }, homeWithToken, '', projectDefault),
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
      await resolve([], { DEFAULT_KEY: 'production-key' }, homeWithKey, '', projectDefault),
    ).toEqual({ url: 'http://127.0.0.1:3000', apiKey, token: undefined, timeoutMs: undefined });
    // A key piped with --api-key-stdin still wins over the stored one.
    expect(
      await resolve(['--api-key-stdin'], {}, homeWithKey, 'stdin-key\n', projectDefault),
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
    expect(await resolve([], {}, home, '', projectDefault)).toMatchObject({
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
    expect(await resolve([], {}, expiredHome, '', projectDefault)).toMatchObject({
      apiKey: undefined,
      token: TOKEN,
    });
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
    expect(await resolve([], { DEFAULT_KEY: 'production-key' }, home, '', cwd)).toEqual({
      url: 'http://127.0.0.1:3001',
      apiKey,
      token: undefined,
      timeoutMs: undefined,
    });
    // §7.1 is unchanged: an explicit URL still outranks the record.
    expect(
      await resolve(['--url', 'https://x.example.com', '--api-key-stdin'], {}, home, 'k', cwd),
    ).toMatchObject({ url: 'https://x.example.com', apiKey: 'k' });

    // A record left by an `aw dev` that was killed: the project file's URL, with the existing error.
    await record(spawnSync(process.execPath, ['-e', '']).pid);
    await expect(
      resolve([], { AGENT_WORKSPACE_API_KEY: 'env-key' }, home, '', cwd),
    ).rejects.toThrow("no credential for this project's local runtime (http://127.0.0.1:3000)");
    // A record naming anything but a port is ignored the same way.
    await writeFile(
      path.join(cwd, '.aw', 'runtime.json'),
      JSON.stringify({ url: 'https://evil.example.com', pid: process.pid }),
    );
    await expect(resolve([], {}, home, '', cwd)).rejects.toThrow('(http://127.0.0.1:3000)');
  });
});
