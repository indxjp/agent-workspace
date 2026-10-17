/**
 * S1-11 (#449): the local runtime's persisted secrets, `.agent-workspace/secrets/local-secrets.json`.
 *
 * Before S1-11 the embedded runtime regenerated its session, encryption and gateway secrets on
 * every start, so a restart signed everyone out and made every stored credential unreadable. The
 * launcher now generates them once per project and reuses them byte for byte afterwards.
 *
 * The runtime directory gets its own `.gitignore` (`*`) before any other file is written in it, so
 * a project that has no root `.gitignore` (`aw init` writes none) still never stages a secret.
 * Errors name the file, never its contents.
 *
 * The file sits in its own `secrets/` directory, a sibling of the run workspaces
 * (`.agent-workspace/workspaces/…`) rather than one of their ancestors, so `../local-secrets.json`
 * climbing out of a workspace does not land on it. That is defence in depth only: under the
 * `local` driver an agent runs as this user, unisolated, and `aw dev --sandbox docker` is the
 * isolation. A file left at the old place, directly in `.agent-workspace/`, is moved on first use.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

/** The per-project directory the local runtime keeps its state in. */
export const RUNTIME_DIRECTORY = '.agent-workspace';

/** The directory, inside {@link RUNTIME_DIRECTORY}, that holds the secrets file. */
export const LOCAL_SECRETS_DIRECTORY = 'secrets';

/** The secrets file, inside {@link LOCAL_SECRETS_DIRECTORY}. */
export const LOCAL_SECRETS_FILE = 'local-secrets.json';

/** The shortest bootstrap password the web server accepts (`apps/web/server/auth/session.ts`). */
const MIN_BOOTSTRAP_PASSWORD_LENGTH = 12;

const MAX_BOOTSTRAP_PASSWORD_LENGTH = 256;

/** What the runtime directory's `.gitignore` says: ignore everything in it. */
const RUNTIME_GITIGNORE = '*\n';

/** Owner read and write only. */
const SECRETS_FILE_MODE = 0o600;

const HexKeySchema = z.string().regex(/^[0-9a-f]{64}$/u, 'must be 64 lowercase hex characters');

export const LocalSecretsSchema = z
  .object({
    SESSION_SECRET: HexKeySchema,
    MASTER_ENCRYPTION_KEY: HexKeySchema,
    GATEWAY_TOKEN_SECRET: HexKeySchema,
    BOOTSTRAP_ADMIN_PASSWORD: z
      .string()
      .min(MIN_BOOTSTRAP_PASSWORD_LENGTH)
      .max(MAX_BOOTSTRAP_PASSWORD_LENGTH),
  })
  .strict()
  .readonly();

export type LocalSecrets = z.infer<typeof LocalSecretsSchema>;

export type LocalSecretKey = keyof LocalSecrets;

const LOCAL_SECRET_KEYS: readonly LocalSecretKey[] = [
  'SESSION_SECRET',
  'MASTER_ENCRYPTION_KEY',
  'GATEWAY_TOKEN_SECRET',
  'BOOTSTRAP_ADMIN_PASSWORD',
];

export type LocalSecretsErrorCode =
  'runtime_directory_invalid' | 'runtime_gitignore_invalid' | 'local_secrets_invalid';

const LOCAL_SECRETS_MESSAGES: Readonly<Record<LocalSecretsErrorCode, (file: string) => string>> = {
  runtime_directory_invalid: (file) =>
    `${file} must be a directory the local runtime can write to; move whatever is there aside`,
  runtime_gitignore_invalid: (file) =>
    `${file} must contain a line "*" and no "!" line, so nothing in the runtime directory is committed`,
  local_secrets_invalid: (file) =>
    `${file} is not a valid local secrets file; move it aside and start again to generate a new one`,
};

export class LocalSecretsError extends Error {
  readonly code: LocalSecretsErrorCode;
  /** The file the error is about; safe to show. */
  readonly path: string;

  constructor(code: LocalSecretsErrorCode, file: string, options?: { readonly cause: unknown }) {
    super(LOCAL_SECRETS_MESSAGES[code](file), options);
    this.name = 'LocalSecretsError';
    this.code = code;
    this.path = file;
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

/**
 * Whether a `.gitignore` ignores everything beside it: a line exactly `*`, and no negation (`!…`)
 * line, since one would un-ignore a file such as the secrets file again.
 */
function ignoresEverything(content: string): boolean {
  const lines = content.split(/\r?\n/u).map((line) => line.trim());
  return lines.includes('*') && !lines.some((line) => line.startsWith('!'));
}

function makeRuntimeDirectory(directory: string, mode?: number): void {
  try {
    mkdirSync(directory, { recursive: true, mode });
  } catch (error) {
    throw new LocalSecretsError('runtime_directory_invalid', directory, { cause: error });
  }
  if (!statSync(directory).isDirectory()) {
    throw new LocalSecretsError('runtime_directory_invalid', directory);
  }
}

/**
 * Create `<projectDir>/.agent-workspace` and its `.gitignore` (`*`), the gitignore first. An
 * existing `.gitignore` must already contain a line exactly `*` and no negation line; anything else
 * is refused rather than rewritten, since it may be the person's own. Returns the directory.
 */
export function ensureRuntimeDirectory(projectDir: string): string {
  const directory = path.join(projectDir, RUNTIME_DIRECTORY);
  makeRuntimeDirectory(directory);
  const gitignore = path.join(directory, '.gitignore');
  try {
    writeFileSync(gitignore, RUNTIME_GITIGNORE, { flag: 'wx' });
    return directory;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  if (!ignoresEverything(readFileSync(gitignore, 'utf8'))) {
    throw new LocalSecretsError('runtime_gitignore_invalid', gitignore);
  }
  return directory;
}

export interface EnsureLocalSecretsOptions {
  /** The random source; tests pass a deterministic one. */
  readonly random?: (size: number) => Buffer;
}

export interface EnsuredLocalSecrets {
  readonly secrets: LocalSecrets;
  /** True when this call generated and wrote the file. */
  readonly created: boolean;
  readonly path: string;
}

function generateSecrets(random: (size: number) => Buffer): LocalSecrets {
  return LocalSecretsSchema.parse({
    SESSION_SECRET: random(32).toString('hex'),
    MASTER_ENCRYPTION_KEY: random(32).toString('hex'),
    GATEWAY_TOKEN_SECRET: random(32).toString('hex'),
    BOOTSTRAP_ADMIN_PASSWORD: random(24).toString('base64url'),
  });
}

function readSecrets(file: string): LocalSecrets {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    // A SyntaxError's message quotes the text it could not parse, so it is not kept as a cause.
    if (error instanceof SyntaxError) throw new LocalSecretsError('local_secrets_invalid', file);
    throw error;
  }
  const result = LocalSecretsSchema.safeParse(parsed);
  if (!result.success) throw new LocalSecretsError('local_secrets_invalid', file);
  return result.data;
}

function tightenMode(file: string): void {
  if (process.platform === 'win32') return;
  if ((statSync(file).mode & 0o777) !== SECRETS_FILE_MODE) chmodSync(file, SECRETS_FILE_MODE);
}

/**
 * Read `<projectDir>/.agent-workspace/secrets/local-secrets.json`, or generate and write it (mode
 * 0600, never overwriting) when it does not exist yet; a file at the pre-move place,
 * `.agent-workspace/local-secrets.json`, is moved there first, so an existing project keeps its
 * secrets. A file that is not JSON or does not match {@link LocalSecretsSchema} is refused with
 * {@link LocalSecretsError}.
 */
export function ensureLocalSecrets(
  projectDir: string,
  options: EnsureLocalSecretsOptions = {},
): EnsuredLocalSecrets {
  const runtime = ensureRuntimeDirectory(projectDir);
  const directory = path.join(runtime, LOCAL_SECRETS_DIRECTORY);
  makeRuntimeDirectory(directory, 0o700);
  const file = path.join(directory, LOCAL_SECRETS_FILE);
  const legacy = path.join(runtime, LOCAL_SECRETS_FILE);
  if (!existsSync(file) && existsSync(legacy)) renameSync(legacy, file);
  const secrets = generateSecrets(options.random ?? randomBytes);
  try {
    writeFileSync(file, `${JSON.stringify(secrets, null, 2)}\n`, {
      mode: SECRETS_FILE_MODE,
      flag: 'wx',
    });
    return { secrets, created: true, path: file };
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  const existing = readSecrets(file);
  tightenMode(file);
  return { secrets: existing, created: false, path: file };
}

/**
 * Fill each secret into `env` unless it is already set there to a non-blank value (by the process
 * environment or `.env`, which win), and return the keys that came from the file. A blank value,
 * such as the `SESSION_SECRET=` line `.env.example` ships, counts as unset: no service could use it.
 */
export function applyLocalSecrets(
  env: Record<string, string | undefined>,
  secrets: LocalSecrets,
): readonly LocalSecretKey[] {
  const applied: LocalSecretKey[] = [];
  for (const key of LOCAL_SECRET_KEYS) {
    if (env[key] !== undefined && env[key].trim() !== '') continue;
    env[key] = secrets[key];
    applied.push(key);
  }
  return applied;
}
