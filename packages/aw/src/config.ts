import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { ParsedArguments } from './args.js';
import { readStoredCredential, urlKey } from './credentials.js';
import { UsageError } from './io.js';
import { readLocalApiKey } from './local-runtime/local-credentials.js';
import { projectUrlOf, readLocalProject, runningRuntimeUrl } from './local-runtime/project.js';

/**
 * The credential a command runs with: a workspace API key, the person's user token from
 * `aw login` (issue #242), or — only for a command that declares it needs none — nothing.
 */
export type CliCredential =
  | { readonly kind: 'api-key'; readonly apiKey: string }
  | { readonly kind: 'user-token'; readonly token: string }
  | { readonly kind: 'none' };

/** What every command needs before it can build a client. */
export interface CliConfig {
  readonly url: string;
  readonly credential: CliCredential;
  readonly timeoutMs: number | undefined;
  /**
   * Lines for stderr: a credential the user set that was deliberately left unused (BH061-022), or
   * one about to travel over plaintext http.
   */
  readonly notices: readonly string[];
}

/**
 * `~/.config/agent-workspace/profiles.json`. A profile names the control plane and the
 * environment variable that holds its key; the key itself is never in the file. OS keychain
 * references are a follow-up — today `apiKeyRef` is only an environment variable name.
 */
const ProfileSchema = z
  .object({ url: z.string().min(1), apiKeyRef: z.string().min(1) })
  .strict()
  .readonly();
const ProfilesFileSchema = z.record(z.string().min(1), ProfileSchema);

type Profile = z.infer<typeof ProfileSchema>;

const DEFAULT_PROFILE_NAME = 'default';

export function profilesFilePath(homeDir: string): string {
  return path.join(homeDir, '.config', 'agent-workspace', 'profiles.json');
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function readProfiles(homeDir: string): Promise<z.infer<typeof ProfilesFileSchema> | null> {
  const filePath = profilesFilePath(homeDir);
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw new UsageError(`could not read ${filePath}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UsageError(`${filePath} is not JSON`);
  }
  const parsed = ProfilesFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new UsageError(
      `${filePath} is malformed: expected { "<name>": { "url": string, "apiKeyRef": string } }`,
    );
  }
  return parsed.data;
}

/**
 * The environment variables every profile names as its key (`apiKeyRef`), so a process `aw` starts
 * for the user's own code can be given an environment without them. Refuses as `resolveConfig`
 * does when the file is unreadable or malformed.
 */
export async function profileKeyRefs(homeDir: string): Promise<readonly string[]> {
  const profiles = await readProfiles(homeDir);
  return profiles === null ? [] : Object.values(profiles).map((profile) => profile.apiKeyRef);
}

/** The named profile, or `default` when none is named; `null` when neither exists. */
async function selectProfile(homeDir: string, name: string | undefined): Promise<Profile | null> {
  const profiles = await readProfiles(homeDir);
  if (name === undefined) return profiles?.[DEFAULT_PROFILE_NAME] ?? null;
  const profile = profiles?.[name];
  if (profile === undefined) {
    throw new UsageError(`profile "${name}" is not defined in ${profilesFilePath(homeDir)}`);
  }
  return profile;
}

function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const timeoutMs = Number(raw);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new UsageError('--timeout must be a positive integer of milliseconds');
  }
  return timeoutMs;
}

/** A value with its surrounding whitespace removed, or `undefined` when nothing is left. */
export function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

export interface ResolveConfigInput {
  readonly args: ParsedArguments;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  /**
   * The directory whose `agent-workspace.yaml` the project step reads (issue #451); `undefined`
   * skips the step.
   */
  readonly cwd: string | undefined;
  readonly readStdin: (flag?: string) => Promise<string>;
  /** `false` for `aw login` and `aw logout`, which run without a credential. */
  readonly credentialRequired: boolean;
}

/**
 * The project step's URL: the local environment of `<cwd>/agent-workspace.yaml`, if any. When a
 * running `aw dev` moved it off a busy port, the port it bound (issue #730); otherwise the file's.
 */
export async function projectUrl(cwd: string | undefined): Promise<string | undefined> {
  if (cwd === undefined) return undefined;
  const read = await readLocalProject(cwd);
  const url = read === null ? undefined : projectUrlOf(read);
  return url === undefined ? undefined : ((await runningRuntimeUrl(cwd)) ?? url);
}

/**
 * §7.1 precedence, with the project step of ADR-0109 (issue #451): `--url`, then the URL of a
 * profile named with `--profile`, then `AGENT_WORKSPACE_URL`, then the project file in the current
 * directory, then the implicit `default` profile.
 *
 * `--profile <name>` is a flag, so a profile named on the command line outranks
 * `AGENT_WORKSPACE_URL` / `AGENT_WORKSPACE_API_KEY` — otherwise `aw --profile staging …` in a
 * shell that exports the production key would send that key to the staging host; only the
 * implicit `default` profile sits below the environment. The project file is read lazily, only
 * when every earlier source is empty; a v2 file names `http://127.0.0.1:<port>` (3000 unless it
 * names a port), a lifted v1 profile names nothing, and a file the schema refuses is a usage error
 * with its line and column.
 *
 * The URL and the key are resolved independently, so a profile may supply the URL while
 * `--api-key-stdin` supplies the key; the implicit `default` profile's key is sent only to that
 * profile's own URL. A key is read from stdin only when `--api-key-stdin` is
 * present. When the URL came from the project file, only a key piped with `--api-key-stdin` is
 * used — never `AGENT_WORKSPACE_API_KEY` nor a profile's key: each was configured for some other
 * control plane (often a shared or production one), and must not travel to whatever listens on the
 * project's local port. With no key from any of those, the unexpired local workspace API key the
 * runtime `aw dev` started issued for this URL (`local-credentials.json`, ADR-0109 as amended by
 * S1-21) is used, and then the unexpired user token `aw login` stored for it (issue #242). The
 * local key comes first because the catalogue routes `aw push` and `aw models` call refuse a user
 * token (ADR-0083 §4); the two are stored apart, so `aw login` never replaces it. A key, where one
 * is configured, always wins, so signing in never silently changes what an already-configured
 * automation acts as.
 */
export async function resolveConfig(input: ResolveConfigInput): Promise<CliConfig> {
  const { args, env } = input;
  const named = args.values.get('profile');
  const profile = await selectProfile(input.homeDir, named);
  const profileUrl = profile?.url;
  const profileKey = profile === null ? undefined : nonBlank(env[profile.apiKeyRef]);
  const explicitUrl =
    nonBlank(args.values.get('url')) ??
    (named === undefined ? undefined : profileUrl) ??
    nonBlank(env['AGENT_WORKSPACE_URL']);
  const fromProject = explicitUrl === undefined ? await projectUrl(input.cwd) : undefined;
  const url = explicitUrl ?? fromProject ?? profileUrl;
  if (url === undefined) {
    throw new UsageError(
      'no control plane URL: pass --url, set AGENT_WORKSPACE_URL, run in a project (agent-workspace.yaml), or define a profile',
    );
  }
  const timeoutMs = parseTimeout(args.values.get('timeout'));
  if (!input.credentialRequired)
    return { url, credential: { kind: 'none' }, timeoutMs, notices: [] };
  const notices: string[] = [];
  // The implicit default profile's key belongs to the default profile's URL, not to any other.
  const defaultKeyApplies = profileUrl !== undefined && urlKey(url) === urlKey(profileUrl);
  const apiKey = args.switches.has('api-key-stdin')
    ? nonBlank(await input.readStdin('--api-key-stdin'))
    : fromProject === undefined
      ? ((named === undefined ? undefined : profileKey) ??
        nonBlank(env['AGENT_WORKSPACE_API_KEY']) ??
        (defaultKeyApplies ? profileKey : undefined))
      : undefined;
  // BH061-022: say why an exported key is not the one in force, instead of ignoring it silently.
  if (
    apiKey === undefined &&
    fromProject !== undefined &&
    nonBlank(env['AGENT_WORKSPACE_API_KEY']) !== undefined
  ) {
    notices.push(
      `AGENT_WORKSPACE_API_KEY is not sent to this project's local runtime (${fromProject}); to use it, set AGENT_WORKSPACE_URL too or pass --url`,
    );
  }
  if (
    apiKey === undefined &&
    named === undefined &&
    profileKey !== undefined &&
    !defaultKeyApplies &&
    fromProject === undefined
  ) {
    notices.push(
      `the default profile's key is not sent to ${url}, which is not its URL; pass --profile, --api-key-stdin or set AGENT_WORKSPACE_API_KEY`,
    );
  }
  const credential = await resolveCredential(input.homeDir, url, apiKey);
  if (credential === null) {
    if (fromProject !== undefined) {
      throw new UsageError(
        `no credential for this project's local runtime (${fromProject}): run \`aw dev\`, or pass --api-key-stdin; AGENT_WORKSPACE_API_KEY and profile keys are not sent to it`,
      );
    }
    throw new UsageError(
      'no credential: run `aw login`, pass --api-key-stdin, set AGENT_WORKSPACE_API_KEY, or define a profile whose apiKeyRef names a set environment variable',
    );
  }
  if (isPlaintextRemote(url)) {
    notices.push(
      `${url} is plain http to a host that is not this machine; the credential travels unencrypted`,
    );
  }
  return { url, credential, timeoutMs, notices };
}

/**
 * A configured key, else the unexpired local key `aw dev` stored for `url`, else the user token
 * `aw login` stored for it; `null` when there is none.
 */
async function resolveCredential(
  homeDir: string,
  url: string,
  apiKey: string | undefined,
): Promise<CliCredential | null> {
  if (apiKey !== undefined) return { kind: 'api-key', apiKey };
  const local = await readLocalApiKey(homeDir, url);
  if (local !== null) return { kind: 'api-key', apiKey: local.apiKey };
  const stored = await readStoredCredential(homeDir, url);
  return stored === null ? null : { kind: 'user-token', token: stored.token };
}

/** Whether `url` names this machine. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** `http:` to anything but this machine: a credential sent there is readable on the network. */
function isPlaintextRemote(url: string): boolean {
  return url.toLowerCase().startsWith('http:') && !isLoopbackUrl(url);
}
