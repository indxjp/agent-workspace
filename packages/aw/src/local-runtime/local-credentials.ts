import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { API_KEY_PATTERN } from '@indx-workspace/contracts/api-keys';
import { IsoDateTimeSchema } from '@indx-workspace/contracts';
import { z } from 'zod';

import { isMissingFile, urlKey, writeOwnerOnlyJsonFile } from '../credentials.js';
import { UsageError } from '../io.js';

/**
 * `~/.config/agent-workspace/local-credentials.json` — S1-21 (issue #500), ADR-0109 as amended:
 * the workspace API key the local runtime `aw dev` started issued, one per local URL.
 *
 * It is a file of its own, not an entry in `credentials.json`, for two reasons:
 *
 *   * every published `aw` (0.2.x) parses the whole of `credentials.json` with a strict schema
 *     that allows only `aw login`'s `{ token, … }` entries, so a key entry there would make an
 *     older `aw` beside a project-local one refuse every command, `aw logout` included;
 *   * `aw login` against the local URL and `aw dev` each keep their own slot, so signing in no
 *     longer replaces the key that `aw push` and the catalogue commands need.
 *
 * It is written the way `credentials.json` is (owner-only, atomically, never printed). Reading is
 * per entry: an entry this version cannot parse — written by a later `aw`, or damaged — is
 * skipped and kept on the next write, never a reason to refuse the file.
 */
const StoredLocalApiKeySchema = z
  .object({
    apiKey: z.string().regex(API_KEY_PATTERN),
    expiresAt: IsoDateTimeSchema,
    workspaceId: z.string().min(1),
    workspaceSlug: z.string().min(1),
  })
  .strict()
  .readonly();

/** The local workspace's API key the runtime `aw dev` started issued (ADR-0109, S1-21). */
export type StoredLocalApiKey = z.infer<typeof StoredLocalApiKeySchema>;

const LocalCredentialsFileSchema = z.record(z.string().min(1), z.unknown());

type LocalCredentialsFile = z.infer<typeof LocalCredentialsFileSchema>;

export function localCredentialsFilePath(homeDir: string): string {
  return path.join(homeDir, '.config', 'agent-workspace', 'local-credentials.json');
}

async function readLocalCredentialsFile(homeDir: string): Promise<LocalCredentialsFile> {
  const filePath = localCredentialsFilePath(homeDir);
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw new UsageError(`could not read ${filePath}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UsageError(`${filePath} is not JSON; delete it and run \`aw dev\` again`);
  }
  const parsed = LocalCredentialsFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new UsageError(`${filePath} is malformed; delete it and run \`aw dev\` again`);
  }
  return parsed.data;
}

/**
 * The local runtime's key stored for `url`, or `null` when there is none, it has expired, or the
 * entry is one this version cannot read.
 */
export async function readLocalApiKey(
  homeDir: string,
  url: string,
  now: Date = new Date(),
): Promise<StoredLocalApiKey | null> {
  const parsed = StoredLocalApiKeySchema.safeParse(
    (await readLocalCredentialsFile(homeDir))[urlKey(url)],
  );
  if (!parsed.success) return null;
  return Date.parse(parsed.data.expiresAt) > now.getTime() ? parsed.data : null;
}

/** Store (or replace) the local runtime's key for `url`, keeping every other entry as it is. */
export async function saveLocalApiKey(
  homeDir: string,
  url: string,
  credential: StoredLocalApiKey,
): Promise<void> {
  const file = await readLocalCredentialsFile(homeDir);
  await writeOwnerOnlyJsonFile(localCredentialsFilePath(homeDir), {
    ...file,
    [urlKey(url)]: credential,
  });
}
