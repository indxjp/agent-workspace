import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CLI_TOKEN_PATTERN } from '@indx-workspace/contracts/cli-auth';
import { IsoDateTimeSchema } from '@indx-workspace/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { credentialsFilePath, saveStoredCredential } from '../credentials.js';
import { tempDirectory } from '../testing.js';
import {
  localCredentialsFilePath,
  readLocalApiKey,
  saveLocalApiKey,
  type StoredLocalApiKey,
} from './local-credentials.js';

/**
 * S1-21 (issue #500): the local runtime's key lives in `local-credentials.json`, never in
 * `credentials.json`, which every published `aw` parses strictly.
 */

/** `credentials.json`'s schema in `aw` 0.2.x, copied verbatim: what an older `aw` still enforces. */
const PublishedCredentialsFileSchema = z.record(
  z.string().min(1),
  z
    .object({
      token: z.string().regex(CLI_TOKEN_PATTERN),
      expiresAt: IsoDateTimeSchema,
      workspaceId: z.string().min(1),
      workspaceSlug: z.string().min(1),
    })
    .strict()
    .readonly(),
);

const USER_TOKEN = `awu_live_${'A'.repeat(22)}_${'S'.repeat(43)}`;
const API_KEY = `ak_live_${'A'.repeat(22)}_${'S'.repeat(43)}`;
const LOCAL_URL = 'http://127.0.0.1:3000';
const REMOTE_URL = 'https://aw.example.com';
const FAR_FUTURE = '2999-01-01T00:00:00.000Z';
const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';

const KEY_ENTRY: StoredLocalApiKey = {
  apiKey: API_KEY,
  expiresAt: FAR_FUTURE,
  workspaceId: WORKSPACE_ID,
  workspaceSlug: 'local',
};

const homes: string[] = [];

async function home(): Promise<string> {
  const directory = await tempDirectory();
  homes.push(directory);
  return directory;
}

async function writeRaw(homeDir: string, content: unknown): Promise<void> {
  const filePath = localCredentialsFilePath(homeDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(content));
}

afterEach(async () => {
  for (const directory of homes.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('the local runtime key file (S1-21)', () => {
  it('round-trips a key, normalising a trailing slash', async () => {
    const homeDir = await home();
    await saveLocalApiKey(homeDir, `${LOCAL_URL}/`, KEY_ENTRY);
    expect(await readLocalApiKey(homeDir, LOCAL_URL)).toEqual(KEY_ENTRY);
    expect(await readLocalApiKey(homeDir, REMOTE_URL)).toBeNull();
  });

  it('leaves credentials.json readable by aw 0.2.x: the key never enters it', async () => {
    const homeDir = await home();
    await saveStoredCredential(homeDir, REMOTE_URL, {
      token: USER_TOKEN,
      expiresAt: FAR_FUTURE,
      workspaceId: WORKSPACE_ID,
      workspaceSlug: 'acme',
    });
    await saveLocalApiKey(homeDir, LOCAL_URL, KEY_ENTRY);

    const credentials: unknown = JSON.parse(await readFile(credentialsFilePath(homeDir), 'utf8'));
    expect(PublishedCredentialsFileSchema.safeParse(credentials).success).toBe(true);
    expect(JSON.stringify(credentials)).not.toContain('ak_live_');
  });

  it('treats an expired key as absent', async () => {
    const homeDir = await home();
    await saveLocalApiKey(homeDir, LOCAL_URL, {
      ...KEY_ENTRY,
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    expect(await readLocalApiKey(homeDir, LOCAL_URL)).toBeNull();
  });

  it('skips an entry it cannot read instead of refusing the file, and keeps it on write', async () => {
    const homeDir = await home();
    const future = { apiKey: API_KEY, expiresAt: FAR_FUTURE, scope: 'a later shape' };
    await writeRaw(homeDir, { 'http://127.0.0.1:4000': future });
    expect(await readLocalApiKey(homeDir, 'http://127.0.0.1:4000')).toBeNull();

    await saveLocalApiKey(homeDir, LOCAL_URL, KEY_ENTRY);
    expect(await readLocalApiKey(homeDir, LOCAL_URL)).toEqual(KEY_ENTRY);
    expect(JSON.parse(await readFile(localCredentialsFilePath(homeDir), 'utf8'))).toEqual({
      'http://127.0.0.1:4000': future,
      [LOCAL_URL]: KEY_ENTRY,
    });
  });

  it('refuses a file that is not a JSON object, without echoing its content', async () => {
    const homeDir = await home();
    await writeRaw(homeDir, [API_KEY]);
    const read = readLocalApiKey(homeDir, LOCAL_URL);
    await expect(read).rejects.toThrow(/is malformed/u);
    const message = await read.then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : ''),
    );
    expect(message).not.toContain('ak_live_');
  });

  // POSIX permission bits do not exist on Windows, so this is asserted on every CI runner.
  it.skipIf(process.platform === 'win32')('stores the key owner-only (0600)', async () => {
    const homeDir = await home();
    await saveLocalApiKey(homeDir, LOCAL_URL, KEY_ENTRY);
    expect((await stat(localCredentialsFilePath(homeDir))).mode % 0o1000).toBe(0o600);
  });
});
