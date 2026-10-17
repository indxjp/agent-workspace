/**
 * `createSecretsService` — this subsystem's own composition root, symmetrical with
 * `packages/core/src/db/repositories/root.ts`'s `openDatabaseRoot()` rather than a client of it.
 * See `repository.ts`'s header for why this subsystem holds its own `pg.Pool` instead of one.
 *
 * ## Ordering is the whole of the "fail closed, not open" property
 *
 * The selected master-key provider loads **before** anything else — before a pool is opened,
 * before a query is issued. A deployment with no usable master key never gets as far as touching
 * PostgreSQL; it fails at construction, which is what "the master key's absence is a startup
 * failure" means in code rather than in prose. The provider tests assert the key check in isolation;
 * `service.test.ts` asserts the ordering — that constructing the service with no key throws
 * without a database ever being reachable, using an intentionally-wrong `DATABASE_URL` to prove
 * the failure did not come from there.
 *
 * ## The public shape: write, and one clearly separate way to read
 *
 * {@link SecretsService.list}, `.create` and `.replace` are what `apps/web/server/secrets/**`
 * calls; none of the three can produce a value. {@link SecretsService.resolveByName} can, and it
 * is the one method this interface has that `apps/web/app/api/secrets/**` must never call —
 * `resolve.ts`'s header explains what actually enforces that. It exists here, on the same object,
 * because the caller the Wave 2 plan names (W2-CP-05) needs exactly this composition —
 * master key loaded, pool open, scope resolved — and building a second composition root next to
 * this one for the sole purpose of hiding one method from it would be security theatre: the same
 * process, the same module graph, and the same master key are already available to any code that
 * runs in this deployment's web server.
 */
import {
  closePool,
  createDatabase,
  createPool,
  readDatabaseConfig,
  type Database,
} from '../db/client.js';
import { requireWorkspaceScope, type WorkspaceScope } from '../db/repositories/scope.js';
import { generateDataKey } from './crypto.js';
import { openSecret, sealSecret } from './envelope.js';
import { loadMasterKey, MASTER_KEY_ENV_VAR, type MasterKey } from './master-key.js';
import { createMasterKeyProvider, type MasterKeyProvider } from './master-key-provider.js';
import {
  createDatabaseSecretsRepositoryProvider,
  createInMemorySecretsRepositoryProvider,
  type CreateSecretOutcome,
  type DeleteSecretOutcome,
  type ReplaceSecretOutcome,
  type SecretMetadata,
} from './repository.js';
import { resolveSecretByName, type ResolvedSecret } from './resolve.js';

/** Everything `POST /api/secrets` supplies: a name and the plaintext value to seal. */
export interface CreateSecretRequest {
  readonly name: string;
  readonly value: Buffer;
}

export interface SecretsService {
  /** Every secret's metadata in `scope`'s workspace. Never a value. */
  list(scope: WorkspaceScope): Promise<readonly SecretMetadata[]>;
  /** Create a new secret, sealing `value` under this process's master key. */
  create(scope: WorkspaceScope, input: CreateSecretRequest): Promise<CreateSecretOutcome>;
  /** Replace an existing secret's value (rotate it) by id. The name does not change. */
  replace(scope: WorkspaceScope, id: string, value: Buffer): Promise<ReplaceSecretOutcome>;
  /** Delete an unreferenced secret. Values are never returned. */
  delete(scope: WorkspaceScope, id: string): Promise<DeleteSecretOutcome>;
  /**
   * Decrypt and return one secret by name. **Not for routes** — see this file's header and
   * `resolve.ts`'s. The one legitimate caller in this wave's plan is W2-CP-05's connector
   * credential resolution, running server-side, never as the direct response to an HTTP request.
   */
  resolveByName(scope: WorkspaceScope, name: string): Promise<ResolvedSecret | null>;
  /** Release the pool this service opened. Idempotent. */
  close(): Promise<void>;
}

export interface CreateSecretsServiceOptions {
  /** Test and embedding seam; production selects from `MASTER_KEY_PROVIDER`. */
  readonly masterKeyProvider?: MasterKeyProvider;
}

/**
 * Load the master key, open a dedicated connection pool, prove it works, and return the service.
 *
 * Throws — never returns a degraded service — when the selected master-key provider is absent or
 * malformed, when `DATABASE_URL` is missing or unusable, or when the server does not answer. No
 * branch in which this function returns something that will later fail on the first request
 * instead of failing here, at startup.
 */
export async function createSecretsService(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: CreateSecretsServiceOptions = {},
): Promise<SecretsService> {
  // First, and unconditionally: no database connection is attempted before the master key is
  // confirmed present and well-formed. This is the ordering `service.test.ts` asserts.
  const masterKeyProvider = options.masterKeyProvider ?? (await createMasterKeyProvider(env));
  const masterKey: MasterKey = await masterKeyProvider.load();

  const pool = createPool(readDatabaseConfig(env));
  let db: Database;
  try {
    db = createDatabase(pool);
    // Same reasoning as `openDatabaseRoot`: a `DATABASE_URL` that merely parses but names an
    // unreachable host must not produce a service that looks installed and fails inside the
    // first request (ADR-0015).
    await pool.query('select 1');
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  const repositories = createDatabaseSecretsRepositoryProvider(db);
  let closed = false;

  return {
    list(scope: WorkspaceScope): Promise<readonly SecretMetadata[]> {
      return repositories.forScope(requireWorkspaceScope(scope, 'SecretsService')).list();
    },

    create(scope: WorkspaceScope, input: CreateSecretRequest): Promise<CreateSecretOutcome> {
      const envelope = sealSecret(masterKey, input.value);
      return repositories
        .forScope(requireWorkspaceScope(scope, 'SecretsService'))
        .create({ name: input.name, envelope });
    },

    replace(scope: WorkspaceScope, id: string, value: Buffer): Promise<ReplaceSecretOutcome> {
      const envelope = sealSecret(masterKey, value);
      return repositories
        .forScope(requireWorkspaceScope(scope, 'SecretsService'))
        .replace(id, envelope);
    },

    delete(scope: WorkspaceScope, id: string): Promise<DeleteSecretOutcome> {
      return repositories.forScope(requireWorkspaceScope(scope, 'SecretsService')).delete(id);
    },

    resolveByName(scope: WorkspaceScope, name: string): Promise<ResolvedSecret | null> {
      return resolveSecretByName(
        db,
        requireWorkspaceScope(scope, 'SecretsService'),
        masterKey,
        name,
      );
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await closePool(pool);
    },
  };
}

/**
 * A {@link SecretsService} with no database and no configured master key — real AES-256-GCM
 * encryption (via the in-memory repository's own storage), a freshly generated master key held
 * only in this process's memory, and nothing durable. For tests and for any caller that wants the
 * real write/read contract without provisioning PostgreSQL — `apps/web/server/secrets/routes.test.ts`
 * is the intended first user, the same role `agents/memory-store.ts` plays for the agent routes.
 *
 * This is **not** a fallback for a deployment with no master key configured — `createSecretsService`
 * still throws in that case, unconditionally. This factory is never called from that one; it exists
 * so a test can get a working, encrypting `SecretsService` without an environment variable or a
 * database at all.
 */
export function createInMemorySecretsService(): SecretsService {
  const masterKey = loadMasterKey({ [MASTER_KEY_ENV_VAR]: generateDataKey().toString('hex') });
  const provider = createInMemorySecretsRepositoryProvider();

  return {
    list(scope: WorkspaceScope): Promise<readonly SecretMetadata[]> {
      return provider.forScope(requireWorkspaceScope(scope, 'SecretsService')).list();
    },

    create(scope: WorkspaceScope, input: CreateSecretRequest): Promise<CreateSecretOutcome> {
      const envelope = sealSecret(masterKey, input.value);
      return provider
        .forScope(requireWorkspaceScope(scope, 'SecretsService'))
        .create({ name: input.name, envelope });
    },

    replace(scope: WorkspaceScope, id: string, value: Buffer): Promise<ReplaceSecretOutcome> {
      const envelope = sealSecret(masterKey, value);
      return provider
        .forScope(requireWorkspaceScope(scope, 'SecretsService'))
        .replace(id, envelope);
    },

    delete(scope: WorkspaceScope, id: string): Promise<DeleteSecretOutcome> {
      return provider.forScope(requireWorkspaceScope(scope, 'SecretsService')).delete(id);
    },

    resolveByName(scope: WorkspaceScope, name: string): Promise<ResolvedSecret | null> {
      const checked = requireWorkspaceScope(scope, 'SecretsService');
      const row = [...provider._debugEnvelopes.values()].find(
        (candidate) =>
          candidate.metadata.workspaceId === checked.workspaceId &&
          candidate.metadata.name === name,
      );
      if (row === undefined) return Promise.resolve(null);
      return Promise.resolve({
        name: row.metadata.name,
        value: openSecret(masterKey, row.envelope),
      });
    },

    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}
