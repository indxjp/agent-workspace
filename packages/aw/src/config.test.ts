import { expect, it } from 'vitest';

import { parseArguments } from './args.js';
import { resolveConfig } from './config.js';

import { UsageError } from './io.js';

import {
  homeWithProfiles,
  homeWithBrokenProfiles,
  emptyHome,
  resolve,
} from './config.fixture.test-support.js';

it('takes the flag over the environment over the profile, field by field', async () => {
  const env = {
    AGENT_WORKSPACE_URL: 'https://env.example.com',
    AGENT_WORKSPACE_API_KEY: 'env-key',
    DEFAULT_KEY: 'from-profile-ref',
  };
  expect(
    await resolve({
      argv: ['--url', 'https://flag.example.com'],
      env: env,
      homeDir: homeWithProfiles,
    }),
  ).toEqual({
    url: 'https://flag.example.com',
    apiKey: 'env-key',
    token: undefined,
    timeoutMs: undefined,
  });
  expect(await resolve({ argv: [], env: env, homeDir: homeWithProfiles })).toMatchObject({
    url: 'https://env.example.com',
    apiKey: 'env-key',
  });
  expect(
    await resolve({ argv: [], env: { DEFAULT_KEY: 'k' }, homeDir: homeWithProfiles }),
  ).toMatchObject({
    url: 'https://default.example.com',
    apiKey: 'k',
  });
});

it("never sends the default profile's key to another URL", async () => {
  const env = { DEFAULT_KEY: 'production-key' };
  await expect(
    resolve({
      argv: ['--url', 'https://elsewhere.example.com'],
      env: env,
      homeDir: homeWithProfiles,
    }),
  ).rejects.toThrow(/no credential: run `aw login`/u);
  await expect(
    resolve({
      argv: [],
      env: { ...env, AGENT_WORKSPACE_URL: 'https://elsewhere.example.com/' },
      homeDir: homeWithProfiles,
    }),
  ).rejects.toThrow(/no credential: run `aw login`/u);
  // The same URL, spelled with a trailing slash, is still the profile's own.
  expect(
    await resolve({
      argv: ['--url', 'https://default.example.com/'],
      env: env,
      homeDir: homeWithProfiles,
    }),
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
  const config = await resolve({
    argv: ['--api-key-stdin'],
    env: { AGENT_WORKSPACE_URL: 'https://env.example.com', AGENT_WORKSPACE_API_KEY: 'env-key' },
    homeDir: emptyHome,
    stdin: 'ak_live_from_stdin\n',
  });
  expect(config.apiKey).toBe('ak_live_from_stdin');
});

it('selects a named profile and refuses an unknown one', async () => {
  expect(
    await resolve({
      argv: ['--profile', 'staging'],
      env: { STAGING_KEY: 's' },
      homeDir: homeWithProfiles,
    }),
  ).toMatchObject({
    url: 'https://staging.example.com',
    apiKey: 's',
  });
  await expect(
    resolve({ argv: ['--profile', 'prod'], env: {}, homeDir: homeWithProfiles }),
  ).rejects.toThrow('profile "prod" is not defined');
});

it('ranks a profile named with --profile above the environment, and the default one below it', async () => {
  // A shell that exports the production pair must not send the production key to staging.
  const env = {
    AGENT_WORKSPACE_URL: 'https://env.example.com',
    AGENT_WORKSPACE_API_KEY: 'env-key',
    STAGING_KEY: 's',
  };
  expect(
    await resolve({ argv: ['--profile', 'staging'], env: env, homeDir: homeWithProfiles }),
  ).toMatchObject({
    url: 'https://staging.example.com',
    apiKey: 's',
  });
  // Still field by field: a flag beats the named profile, and an unset apiKeyRef falls back.
  expect(
    await resolve({
      argv: ['--profile', 'staging', '--url', 'https://flag.example.com'],
      env: env,
      homeDir: homeWithProfiles,
    }),
  ).toMatchObject({ url: 'https://flag.example.com', apiKey: 's' });
  expect(
    await resolve({
      argv: ['--profile', 'staging'],
      env: { AGENT_WORKSPACE_API_KEY: 'env-key' },
      homeDir: homeWithProfiles,
    }),
  ).toMatchObject({ url: 'https://staging.example.com', apiKey: 'env-key' });
  // Without --profile the implicit default stays below the environment, as before.
  expect(await resolve({ argv: [], env: env, homeDir: homeWithProfiles })).toMatchObject({
    url: 'https://env.example.com',
    apiKey: 'env-key',
  });
});

it('explains a missing URL and a missing key as usage errors', async () => {
  await expect(resolve({ argv: [], env: {}, homeDir: emptyHome })).rejects.toThrow(
    /no control plane URL/u,
  );
  await expect(
    resolve({ argv: ['--url', 'https://x.example.com'], env: {}, homeDir: emptyHome }),
  ).rejects.toThrow(/no credential: run `aw login`/u);
  await expect(
    resolve({ argv: [], env: { DEFAULT_KEY: '' }, homeDir: homeWithProfiles }),
  ).rejects.toBeInstanceOf(UsageError);
});

it('refuses a profiles file that carries anything but url and apiKeyRef', async () => {
  await expect(resolve({ argv: [], env: {}, homeDir: homeWithBrokenProfiles })).rejects.toThrow(
    /malformed/u,
  );
});

it('parses --timeout as positive milliseconds', async () => {
  const env = { AGENT_WORKSPACE_URL: 'https://x', AGENT_WORKSPACE_API_KEY: 'k' };
  expect(
    (await resolve({ argv: ['--timeout', '2500'], env: env, homeDir: emptyHome })).timeoutMs,
  ).toBe(2500);
  await expect(
    resolve({ argv: ['--timeout', 'soon'], env: env, homeDir: emptyHome }),
  ).rejects.toThrow(/--timeout/u);
});
