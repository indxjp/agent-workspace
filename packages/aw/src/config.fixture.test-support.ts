import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll } from 'vitest';

import { parseArguments } from './args.js';
import { profilesFilePath, resolveConfig } from './config.js';

export let homeWithProfiles: string;
export let homeWithBrokenProfiles: string;
export let emptyHome: string;

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
export async function resolve({
  argv,
  env,
  homeDir,
  stdin = '',
  cwd,
}: {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly stdin?: string;
  readonly cwd?: string;
}) {
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
