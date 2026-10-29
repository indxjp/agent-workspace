/**
 * Parsing request bodies and building response resources for `/api/runtime-profiles` — spec
 * §15.1, validated with Zod.
 *
 * Unlike `apps/web/server/agents/contract.ts`, which hand-rolls its parsers, this file validates
 * through the Zod schemas `packages/run-protocol/src/schemas.ts` already builds for exactly this purpose
 * (`RuntimeProfile`, `CreateRuntimeProfileInput`, `UpdateRuntimeProfileInput` — spec §15.1,
 * ADR-0042). Re-deriving the same validation by hand here would be the second copy ADR-0042
 * exists to prevent, in the one package that already has `zod` resolving (`@agent-workspace/core`,
 * which `apps/web/package.json` already depends on).
 */
import { toObjectKey, UnsafeObjectKeyError } from '@agent-workspace/core/storage/keys';
import {
  CreateRuntimeProfileInput as CreateRuntimeProfileInputSchema,
  UpdateRuntimeProfileInput as UpdateRuntimeProfileInputSchema,
} from '@agent-workspace/run-protocol';

import { formatIssues } from '../http/result';
import type {
  CreateRuntimeProfileInput,
  RuntimeProfileRecord,
  UpdateRuntimeProfilePatch,
} from './store';

/** A parse's answer: the value, or every human-readable reason it failed. */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** `runtime_profiles.id` is a `uuid` column, so a non-UUID cannot match a row (ADR-0015). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Whole words that name a credential once a key is split into its camelCase, snake_case,
 * kebab-case and digit-separated words (`APIKey2` → `api key`, `oauth2token` → `oauth token`).
 * Whole words only here: `maxTokens` and `tokenizer` are settings.
 */
const CREDENTIAL_WORDS = new Set([
  'secret',
  'secrets',
  'token',
  'sas',
  'authorization',
  'bearer',
  'connectionstring',
]);

/** Adjacent word pairs that name a credential: `apiKey`, `access_key`, `connection-string`… */
const CREDENTIAL_WORD_PAIRS = new Set([
  'api key',
  'api token',
  'access key',
  'access token',
  'refresh token',
  'secret key',
  'private key',
  'auth token',
  'client secret',
  'connection string',
]);

/**
 * Fragments that name a credential wherever they sit inside one word, so a run-together
 * lowercase key (`dbpassword`, `apitoken`, `accesskeyid`, `sessioncookie`) is caught too.
 */
const CREDENTIAL_FRAGMENTS = [
  'password',
  'passwd',
  'passphrase',
  'apikey',
  'apitoken',
  'accesskey',
  'secretkey',
  'privatekey',
  'clientsecret',
  'authtoken',
  'credential',
  'cookie',
] as const;

/** Words that contain a fragment but name a setting, not a credential. */
const NON_CREDENTIAL_WORDS = new Set(['passwordless']);

/** Endings that name a credential at the end of one word: `githubtoken`, `webhooksecret`. */
const CREDENTIAL_WORD_ENDINGS = ['token', 'secret'] as const;

/** A key ending in one of these words names a reference to a secret, not the secret itself. */
const REFERENCE_SUFFIXES = new Set(['ref', 'refs', 'name', 'names']);

/** Kubernetes' list of pull-secret *names*, whatever its last word says. */
const REFERENCE_KEYS = new Set(['image pull secrets']);

/** How deep `driverConfig` may nest; deeper is refused rather than walked. */
const DRIVER_CONFIG_MAX_DEPTH = 32;

function keyWords(key: string): string[] {
  return key
    .replaceAll(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replaceAll(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/u)
    .filter((word) => word !== '');
}

function wordNamesCredential(word: string): boolean {
  if (CREDENTIAL_WORDS.has(word)) return true;
  if (NON_CREDENTIAL_WORDS.has(word)) return false;
  return (
    CREDENTIAL_FRAGMENTS.some((fragment) => word.includes(fragment)) ||
    CREDENTIAL_WORD_ENDINGS.some((ending) => word.endsWith(ending))
  );
}

/** Whether two adjacent words name a credential, the second singular or plural (`apiKeys`). */
function namesCredentialPair(word: string, next: string): boolean {
  return (
    CREDENTIAL_WORD_PAIRS.has(`${word} ${next}`) ||
    CREDENTIAL_WORD_PAIRS.has(`${word} ${next.replace(/s$/u, '')}`)
  );
}

function looksLikeCredentialKey(key: string): boolean {
  const words = keyWords(key);
  if (REFERENCE_KEYS.has(words.join(' '))) return false;
  if (REFERENCE_SUFFIXES.has(words.at(-1) ?? '')) return false;
  return words.some(
    (word, index) => wordNamesCredential(word) || namesCredentialPair(word, words[index + 1] ?? ''),
  );
}

/**
 * Collect into `found` the dotted path of every key under `value` whose name looks like a
 * credential. Answers `false` when `value` nests deeper than {@link DRIVER_CONFIG_MAX_DEPTH}.
 */
function collectCredentialKeyPaths(
  value: unknown,
  prefix: string,
  depth: number,
  found: string[],
): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (depth > DRIVER_CONFIG_MAX_DEPTH) return false;
  const entries = Array.isArray(value)
    ? value.map((item, index): [string, unknown] => [String(index), item])
    : Object.entries(value);
  for (const [key, child] of entries) {
    const path = `${prefix}.${key}`;
    if (!Array.isArray(value) && looksLikeCredentialKey(key)) found.push(path);
    else if (!collectCredentialKeyPaths(child, path, depth + 1, found)) return false;
  }
  return true;
}

/**
 * `driverConfig` must not carry a credential (ADR-0088 D2): a Builder reads every profile, and
 * secrets belong on a runtime connection, encrypted and never read back (§14.9). Key names are
 * checked, at any depth up to {@link DRIVER_CONFIG_MAX_DEPTH}; a value cannot be told to be a
 * secret. Only writes are checked, so a profile stored before the rule still reads.
 */
function refuseDriverConfigCredentials(
  driverConfig: Readonly<Record<string, unknown>> | undefined,
): string[] {
  const found: string[] = [];
  if (!collectCredentialKeyPaths(driverConfig, 'driverConfig', 1, found)) {
    return [
      `driverConfig: nests deeper than ${String(DRIVER_CONFIG_MAX_DEPTH)} levels, which is ` +
        'refused',
    ];
  }
  return found.map(
    (path) =>
      `${path}: driverConfig must not carry credentials; store them on a runtime connection ` +
      'and reference it with runtimeConnectionId',
  );
}

/**
 * A runtime path as the runner's workspace-relative form: a leading `/workspace` segment is
 * stripped (`/workspaces/…` is not that segment), and an empty, absolute, `.` or `..` path is
 * refused. The launcher maps `persistPaths` through this after a run, so a profile write checks
 * every entry with it first.
 */
export function relativeRuntimePath(value: string): string {
  try {
    return toObjectKey(value.replaceAll('\\', '/').replace(/^\/workspace(?:\/|$)/u, ''));
  } catch (cause) {
    if (!(cause instanceof UnsafeObjectKeyError)) throw cause;
    throw new Error(`persist path ${JSON.stringify(value)} is not workspace-relative`, { cause });
  }
}

/** One error per `persistPaths` entry {@link relativeRuntimePath} refuses, named by index. */
function refuseUnusablePersistPaths(persistPaths: readonly string[] | null | undefined): string[] {
  return (persistPaths ?? []).flatMap((path, index) => {
    try {
      relativeRuntimePath(path);
      return [];
    } catch {
      return [`persistPaths.${String(index)}: must be a relative path inside the workspace`];
    }
  });
}

/** `POST /api/runtime-profiles`'s body, parsed and reshaped to the store's null-based fields. */
export function parseCreateRuntimeProfileInput(
  raw: unknown,
): ParseResult<CreateRuntimeProfileInput> {
  const result = CreateRuntimeProfileInputSchema.safeParse(raw);
  if (!result.success) return { ok: false, errors: formatIssues(result.error.issues) };
  const value = result.data;
  const refusals = [
    ...refuseDriverConfigCredentials(value.driverConfig),
    ...refuseUnusablePersistPaths(value.persistPaths),
  ];
  if (refusals.length > 0) return { ok: false, errors: refusals };
  const image = value.driverConfig?.['image'];
  if (
    image !== undefined &&
    (typeof image !== 'string' || !/^.+@sha256:[0-9a-f]{64}$/u.test(image))
  ) {
    return {
      ok: false,
      errors: ['driverConfig.image: non-local runtime profiles must pin an image by sha256 digest'],
    };
  }
  return {
    ok: true,
    value: {
      name: value.name,
      driver: value.driver,
      runtimeConnectionId: value.runtimeConnectionId ?? null,
      cpu: value.cpu ?? null,
      memoryMb: value.memoryMb ?? null,
      diskMb: value.diskMb ?? null,
      networkPolicy: value.networkPolicy,
      allowedDomains: value.allowedDomains ?? null,
      filesystem: value.filesystem,
      persistPaths: value.persistPaths ?? null,
      timeoutSeconds: value.timeoutSeconds ?? null,
      idleTimeoutSeconds: value.idleTimeoutSeconds ?? null,
      driverConfig: value.driverConfig ?? null,
    },
  };
}

/**
 * `PATCH /api/runtime-profiles/:id`'s body. Every key is optional (an absent key means "leave it
 * alone"); a key that *is* present but nullable in the schema (`runtimeConnectionId`, `driver`
 * config-bearing fields) is reshaped to the store's null-based patch the same way create is.
 */
export function parseUpdateRuntimeProfilePatch(
  raw: unknown,
): ParseResult<UpdateRuntimeProfilePatch> {
  const result = UpdateRuntimeProfileInputSchema.safeParse(raw);
  if (!result.success) return { ok: false, errors: formatIssues(result.error.issues) };
  const value = result.data;
  const refusals = [
    ...refuseDriverConfigCredentials(value.driverConfig),
    ...refuseUnusablePersistPaths(value.persistPaths),
  ];
  if (refusals.length > 0) return { ok: false, errors: refusals };
  const patch: {
    name?: string;
    driver?: CreateRuntimeProfileInput['driver'];
    runtimeConnectionId?: string | null;
    cpu?: number | null;
    memoryMb?: number | null;
    diskMb?: number | null;
    networkPolicy?: CreateRuntimeProfileInput['networkPolicy'];
    allowedDomains?: readonly string[] | null;
    filesystem?: CreateRuntimeProfileInput['filesystem'];
    persistPaths?: readonly string[] | null;
    timeoutSeconds?: number | null;
    idleTimeoutSeconds?: number | null;
    driverConfig?: Record<string, unknown> | null;
  } = {};
  if (value.name !== undefined) patch.name = value.name;
  if (value.driver !== undefined) patch.driver = value.driver;
  if ('runtimeConnectionId' in value) patch.runtimeConnectionId = value.runtimeConnectionId ?? null;
  if ('cpu' in value) patch.cpu = value.cpu ?? null;
  if ('memoryMb' in value) patch.memoryMb = value.memoryMb ?? null;
  if ('diskMb' in value) patch.diskMb = value.diskMb ?? null;
  if (value.networkPolicy !== undefined) patch.networkPolicy = value.networkPolicy;
  if ('allowedDomains' in value) patch.allowedDomains = value.allowedDomains ?? null;
  if (value.filesystem !== undefined) patch.filesystem = value.filesystem;
  if ('persistPaths' in value) patch.persistPaths = value.persistPaths ?? null;
  if ('timeoutSeconds' in value) patch.timeoutSeconds = value.timeoutSeconds ?? null;
  if ('idleTimeoutSeconds' in value) patch.idleTimeoutSeconds = value.idleTimeoutSeconds ?? null;
  if ('driverConfig' in value) patch.driverConfig = value.driverConfig ?? null;
  return { ok: true, value: patch };
}

/** What `/api/runtime-profiles` hands back on the wire: the record, with dates as ISO strings. */
export interface RuntimeProfileResource {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly driver: string;
  readonly runtimeConnectionId: string | null;
  readonly cpu: number | null;
  readonly memoryMb: number | null;
  readonly diskMb: number | null;
  readonly networkPolicy: string;
  readonly allowedDomains: readonly string[] | null;
  readonly filesystem: string;
  readonly persistPaths: readonly string[] | null;
  readonly timeoutSeconds: number | null;
  readonly idleTimeoutSeconds: number | null;
  readonly driverConfig: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toRuntimeProfileResource(profile: RuntimeProfileRecord): RuntimeProfileResource {
  return {
    id: profile.id,
    workspaceId: profile.workspaceId,
    name: profile.name,
    driver: profile.driver,
    runtimeConnectionId: profile.runtimeConnectionId,
    cpu: profile.cpu,
    memoryMb: profile.memoryMb,
    diskMb: profile.diskMb,
    networkPolicy: profile.networkPolicy,
    allowedDomains: profile.allowedDomains,
    filesystem: profile.filesystem,
    persistPaths: profile.persistPaths,
    timeoutSeconds: profile.timeoutSeconds,
    idleTimeoutSeconds: profile.idleTimeoutSeconds,
    driverConfig: profile.driverConfig,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}
