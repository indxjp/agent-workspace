/**
 * `@agent-workspace/core/settings` — the settings web and the model gateway share (refactoring part
 * 03): the database, the master key and tracing.
 *
 * Each variable is parsed where it is used (`db/client.ts`, `secrets/master-key-config.ts`,
 * `secrets/master-key.ts`, `telemetry/tracing-settings.ts`). This module lists them, with their
 * defaults and meanings, so `docs/operations/settings.md` is generated from one place; the table
 * test runs those parsers to prove the list is complete.
 *
 * What a bad value does differs by process, on purpose. Web keeps serving and says what is wrong:
 * without a usable database every `/api/**` route answers 503 (ADR W2-DB-02), and without a usable
 * master key the secrets API answers 503 (issue #1562). The model gateway needs both, so it does
 * not start. Imports no cloud SDK and opens no connection.
 */
import { DEFAULT_MAX_CONNECTIONS, MAX_MAX_CONNECTIONS } from './db/client.js';
import { MASTER_KEY_ENV_VAR } from './secrets/master-key.js';

// The parsers this catalogue describes, for the table test that proves it complete. The database's
// own reader stays behind the database layer: the test reaches it through `core/db/unscoped`.
export {
  checkGoogleSecretVersion,
  configuredMasterKeyBackend,
  readAwsKmsMasterKeyConfig,
  readAzureKeyVaultMasterKeyConfig,
  readGoogleSecretManagerSecretVersion,
} from './secrets/master-key-config.js';
export { loadMasterKey } from './secrets/master-key.js';
export { readTracingSettings } from './telemetry/tracing-settings.js';

/** One row of the generated settings table. */
export interface SettingDescription {
  readonly name: string;
  readonly default: string;
  readonly meaning: string;
}

export const CORE_SETTINGS: readonly SettingDescription[] = [
  {
    name: 'DATABASE_URL',
    default: 'none: web answers 503 on every /api/** route; the model gateway does not start',
    meaning:
      'Web and the model gateway: the PostgreSQL connection string, `postgres://` or `postgresql://`, with a host or a ' +
      '`host=` socket. A value that does not parse, or a server that does not answer, is the same as unset.',
  },
  {
    name: 'DATABASE_POOL_MAX',
    default: String(DEFAULT_MAX_CONNECTIONS),
    meaning: `Most connections each process's pool opens, 1 to ${String(MAX_MAX_CONNECTIONS)}. Any other value has the same effect as an unusable \`DATABASE_URL\`.`,
  },
  {
    name: 'MASTER_KEY_PROVIDER',
    default: '`local-key`',
    meaning:
      'Web and the model gateway: where the key that encrypts stored secrets comes from: `local-key`, `kms`, `secret-manager` or ' +
      '`key-vault`. Any other value, or a provider setting below that is missing or malformed, ' +
      'leaves the secrets API in web answering 503 and stops the model gateway from starting.',
  },
  {
    name: MASTER_KEY_ENV_VAR,
    default: 'none: the secrets API in web is off; the model gateway does not start',
    meaning:
      '`local-key`: the master key, 64 hex characters (32 bytes). Set but malformed also fails ' +
      '`/api/readyz`. Changing it makes stored secrets unreadable.',
  },
  {
    name: 'AWS_KMS_KEY_ID',
    default: 'none',
    meaning: '`kms`: the AWS KMS key that decrypts the master key.',
  },
  {
    name: 'AWS_KMS_ENCRYPTED_MASTER_KEY',
    default: 'none',
    meaning: '`kms`: the master key encrypted by that KMS key, in canonical base64.',
  },
  {
    name: 'GCP_MASTER_KEY_SECRET',
    default: 'none',
    meaning:
      '`secret-manager`: the Secret Manager version holding the master key, ' +
      '`projects/<project>/secrets/<secret>/versions/<version>`.',
  },
  {
    name: 'AZURE_KEY_VAULT_URL',
    default: 'none',
    meaning: '`key-vault`: the vault, an `https://` origin with no path, query or credentials.',
  },
  {
    name: 'AZURE_MASTER_KEY_SECRET_NAME',
    default: 'none',
    meaning: '`key-vault`: the name of the secret holding the master key.',
  },
  {
    name: 'AZURE_CLIENT_ID',
    default: 'unset: the default Azure credential',
    meaning: '`key-vault`: the user-assigned managed identity that reads the vault.',
  },
  {
    name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    default: 'unset: no traces are exported',
    meaning:
      'The OpenTelemetry collector web, the model gateway and the runner send traces to. A collector ' +
      'that cannot be reached is logged once; the process keeps serving.',
  },
  {
    name: 'OTEL_SERVICE_NAME',
    default:
      'unset: `agent-workspace-runner` or `agent-workspace-gateway`; web uses the OpenTelemetry default',
    meaning: 'The service name on exported traces.',
  },
];

/**
 * The two database process entries, `db:migrate` (`node dist/db/migrate.js`) and `db:seed`
 * (`node dist/db/seed.js`), read these in `main()` besides `DATABASE_URL` and `DATABASE_POOL_MAX`
 * above. A bad value stops either process before it writes anything.
 */
export const DATABASE_TOOL_SETTINGS: readonly SettingDescription[] = [
  {
    name: 'MIGRATIONS_DIR',
    default: 'the `migrations/` directory at the repository root, found from the package itself',
    meaning:
      '`db:migrate`: where the migrations are, for an image that copies them somewhere else. Blank is the same as unset.',
  },
  {
    name: 'BOOTSTRAP_ADMIN',
    default: 'none: `db:seed` refuses to run',
    meaning:
      '`db:seed`: the email address of the first workspace owner. The seed never invents one. Stored lower-cased.',
  },
  {
    name: 'BOOTSTRAP_ADMIN_NAME',
    default: 'the part of `BOOTSTRAP_ADMIN` before `@`, lower-cased',
    meaning: "`db:seed`: that owner's display name. Blank is the same as unset.",
  },
  {
    name: 'WORKSPACE_SLUG',
    default: '`default`',
    meaning:
      '`db:seed`: the slug of the workspace it creates: lower-case letters, digits and `-`, up to 63. ' +
      'Web serves the workspace its own `WORKSPACE_SLUG` names, so set both the same.',
  },
  {
    name: 'WORKSPACE_NAME',
    default: '`Default Workspace`',
    meaning: "`db:seed`: the workspace's display name. Blank is the same as unset.",
  },
];
