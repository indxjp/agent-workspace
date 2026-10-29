/**
 * The secrets repository — metadata in, metadata out, **never** an envelope.
 *
 * Copies the shape `packages/core/src/db/repositories/agents.ts` established (read that file
 * first): a repository is obtained *for a {@link WorkspaceScope}*, no method takes a workspace id,
 * and a write failure that the caller can act on comes back as a named outcome rather than a
 * thrown constraint violation.
 *
 * ## Why this file imports `../db/*.js` by relative path rather than `@agent-workspace/core/db`
 *
 * `packages/core/src/db/index.ts`'s own header says its public surface is deliberately narrow —
 * repository providers and nothing that reaches raw SQL — and this task's brief says plainly "do
 * not widen it; it is not in your Owns globs anyway." A relative path from inside
 * `packages/core/src/secrets/**` into `packages/core/src/db/**`'s *source* does not go through
 * that barrel at all, and `packages/core/src/db/repositories/database-reachability.test.ts` (that
 * gate, not owned by this task either) explicitly permits exactly this edge: its `decide()`
 * classifier's second arm reads *"a path into the layer's source from inside the package that owns
 * it"* and marks it `permitted`. This module is that permitted edge, used rather than described.
 *
 * The consequence, stated so it is not mistaken for an oversight: this repository opens and
 * migrates against **its own** `pg.Pool`, entirely separate from the one
 * `packages/core/src/db/repositories/root.ts`'s `openDatabaseRoot()` holds for agents, runs and
 * sessions. `DatabaseRoot` was not widened with a `secrets` field — that would have meant editing
 * `root.ts`, `repositories/index.ts` and `db/index.ts`, none of which this task owns — so
 * `service.ts` in this directory is this subsystem's own composition root, symmetrical with
 * `openDatabaseRoot()` rather than a client of it. Both pools point at the same PostgreSQL server
 * in every deployment this repository ships; a future task that wants one pool for both is free to
 * make that change from the side that owns `root.ts`.
 *
 * ## What never appears here
 *
 * No method on {@link SecretsRepository} returns `wrappedDataKey`, either nonce, either tag, or
 * `ciphertext`. {@link SecretMetadata} does not have fields for them. That is enforced by the type
 * the whole write path is built on, not by a reviewer remembering not to add a field — the same
 * shape choice `packages/core/src/db/schema/secrets.ts`'s header makes about the table. Reading an
 * envelope back out (for decryption, never for display) is `resolve.ts`'s job, on a separate,
 * distinctly named path this module does not expose.
 */
import crypto from 'node:crypto';

import { STORAGE_CONNECTION_SECRET_PREFIX } from '@indx-workspace/contracts/secret-reference';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { mcpServers } from '../db/schema/mcp-servers.js';
import { modelConnections } from '../db/schema/model-connections.js';
import { secrets, type SecretAlgorithm } from '../db/schema/secrets.js';
import { storageConnections } from '../db/schema/storage-connections.js';
import { requireWorkspaceScope, type WorkspaceScope } from '../db/repositories/scope.js';
import { postgresViolations } from '../db/repositories/violations.js';
import type { SecretEnvelope } from './envelope.js';

/** One secret, as anything reachable from a route is allowed to know about it. No value, ever. */
export interface SecretMetadata {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly algorithm: SecretAlgorithm;
  readonly masterKeyId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What `POST /api/secrets` supplies to the repository: a name, and an already-sealed envelope. */
export interface CreateSecretInput {
  readonly name: string;
  readonly envelope: SecretEnvelope;
}

export type CreateSecretOutcome =
  | { readonly kind: 'created'; readonly secret: SecretMetadata }
  | { readonly kind: 'name-conflict'; readonly name: string };

export type ReplaceSecretOutcome =
  { readonly kind: 'replaced'; readonly secret: SecretMetadata } | { readonly kind: 'not-found' };

/**
 * Everything that still references a secret. A connector references its credential by the
 * `mcp_servers.credential_secret_id` foreign key; a model connection owns the secret named
 * `MODEL_CONNECTION_<id without dashes, upper-case>` by convention until RF-204 replaces the
 * convention with a foreign key; a storage connection owns `STORAGE_CONNECTION_<the same>`.
 */
export interface SecretReferrers {
  readonly connectorIds: readonly string[];
  readonly modelConnectionIds: readonly string[];
  readonly storageConnectionIds: readonly string[];
}

export type DeleteSecretOutcome =
  | { readonly kind: 'deleted'; readonly secret: SecretMetadata }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'in-use'; readonly referrers: SecretReferrers };

/**
 * Secret metadata persistence for exactly one workspace. No method takes a workspace id, and no
 * method returns anything a caller could decrypt or forward as a credential.
 */
export interface SecretsRepository {
  /** Every secret's metadata in this workspace, oldest first, ties broken by id. */
  list(): Promise<readonly SecretMetadata[]>;
  /** Create a new secret. `name-conflict` on `secrets_workspace_name_key`. */
  create(input: CreateSecretInput): Promise<CreateSecretOutcome>;
  /**
   * Replace an existing secret's envelope (rotate its value) by id. The name is not changeable
   * through this method — a rename is a different secret as far as anything that references one
   * by name is concerned, so it is not offered as a side effect of a value rotation.
   */
  replace(id: string, envelope: SecretEnvelope): Promise<ReplaceSecretOutcome>;
  /**
   * Delete an unreferenced secret by id. A referenced one is refused as `in-use`, naming every
   * referrer; the reference check and the delete run in one transaction that locks the row.
   */
  delete(id: string): Promise<DeleteSecretOutcome>;
}

export interface SecretsRepositoryProvider {
  forScope(scope: WorkspaceScope): SecretsRepository;
}

/** Transcribed from `secrets_name_shape` in `../db/schema/secrets.ts`, for the in-memory provider. */
const SECRET_NAME_SHAPE = /^[A-Z][A-Z0-9_]{0,127}$/u;

const NAME_CONFLICT_CONSTRAINTS: ReadonlySet<string> = new Set(['secrets_workspace_name_key']);
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const SECRET_REFERENCE_CONSTRAINTS = new Set(['mcp_servers_credential_secret_workspace_fk']);

function classifyWriteFailure(error: unknown): 'name-conflict' | null {
  for (const failure of postgresViolations(error)) {
    if (failure.code === UNIQUE_VIOLATION && NAME_CONFLICT_CONSTRAINTS.has(failure.constraint)) {
      return 'name-conflict';
    }
  }
  return null;
}

/** The columns a metadata read selects. Deliberately excludes every envelope column. */
const METADATA_COLUMNS = {
  id: secrets.id,
  workspaceId: secrets.workspaceId,
  name: secrets.name,
  algorithm: secrets.algorithm,
  masterKeyId: secrets.masterKeyId,
  createdAt: secrets.createdAt,
  updatedAt: secrets.updatedAt,
} as const;

function toMetadata(row: {
  id: string;
  workspaceId: string;
  name: string;
  algorithm: string;
  masterKeyId: string;
  createdAt: Date;
  updatedAt: Date;
}): SecretMetadata {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    // `algorithm` is `text` with a CHECK in the database; the schema's own generic parameter
    // types the Drizzle read as `SecretAlgorithm` already, so this is a re-assertion of that
    // contract at the repository boundary rather than a cast introducing one.
    algorithm: row.algorithm as SecretAlgorithm,
    masterKeyId: row.masterKeyId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The PostgreSQL {@link SecretsRepositoryProvider}. One pool, any number of scopes. */
export function createDatabaseSecretsRepositoryProvider(db: Database): SecretsRepositoryProvider {
  return {
    forScope(scope: WorkspaceScope): SecretsRepository {
      const checked = requireWorkspaceScope(scope, 'SecretsRepositoryProvider');
      const tenant = eq(secrets.workspaceId, checked.workspaceId);
      const within = (rest: SQL): SQL => {
        const combined = and(tenant, rest);
        if (combined === undefined) throw new Error('the workspace predicate could not be built');
        return combined;
      };

      return {
        async list(): Promise<readonly SecretMetadata[]> {
          const rows = await db
            .select(METADATA_COLUMNS)
            .from(secrets)
            .where(tenant)
            .orderBy(asc(secrets.createdAt), asc(secrets.id));
          return rows.map(toMetadata);
        },

        async create(input: CreateSecretInput): Promise<CreateSecretOutcome> {
          try {
            const rows = await db
              .insert(secrets)
              .values({
                workspaceId: checked.workspaceId,
                name: input.name,
                algorithm: input.envelope.algorithm,
                masterKeyId: input.envelope.masterKeyId,
                wrappedDataKey: input.envelope.wrappedDataKey,
                wrappedDataKeyNonce: input.envelope.wrappedDataKeyNonce,
                wrappedDataKeyTag: input.envelope.wrappedDataKeyTag,
                ciphertext: input.envelope.ciphertext,
                ciphertextNonce: input.envelope.ciphertextNonce,
                ciphertextTag: input.envelope.ciphertextTag,
              })
              .returning(METADATA_COLUMNS);
            const row = rows[0];
            if (row === undefined) throw new Error('the insert returned no row');
            return { kind: 'created', secret: toMetadata(row) };
          } catch (error) {
            if (classifyWriteFailure(error) === 'name-conflict') {
              return { kind: 'name-conflict', name: input.name };
            }
            throw error;
          }
        },

        async replace(id: string, envelope: SecretEnvelope): Promise<ReplaceSecretOutcome> {
          const rows = await db
            .update(secrets)
            .set({
              algorithm: envelope.algorithm,
              masterKeyId: envelope.masterKeyId,
              wrappedDataKey: envelope.wrappedDataKey,
              wrappedDataKeyNonce: envelope.wrappedDataKeyNonce,
              wrappedDataKeyTag: envelope.wrappedDataKeyTag,
              ciphertext: envelope.ciphertext,
              ciphertextNonce: envelope.ciphertextNonce,
              ciphertextTag: envelope.ciphertextTag,
            })
            .where(within(eq(secrets.id, id)))
            .returning(METADATA_COLUMNS);
          const row = rows[0];
          // No row matched: either no such id, or the id belongs to another workspace. Reported
          // identically on purpose — see agents.ts's header for why a 404 and not a 403.
          return row === undefined
            ? { kind: 'not-found' }
            : { kind: 'replaced', secret: toMetadata(row) };
        },

        async delete(id: string): Promise<DeleteSecretOutcome> {
          try {
            return await db.transaction(async (tx): Promise<DeleteSecretOutcome> => {
              // The row lock serialises this check against a concurrent reference: a connector
              // insert or update naming this secret waits on it (its foreign key takes a share
              // lock), then fails the foreign key once the row is gone.
              const locked = await tx
                .select(METADATA_COLUMNS)
                .from(secrets)
                .where(within(eq(secrets.id, id)))
                .for('update');
              const row = locked[0];
              if (row === undefined) return { kind: 'not-found' };
              const connectors = await tx
                .select({ id: mcpServers.id })
                .from(mcpServers)
                .where(
                  and(
                    eq(mcpServers.workspaceId, checked.workspaceId),
                    eq(mcpServers.credentialSecretId, id),
                  ),
                )
                .orderBy(asc(mcpServers.id));
              const models = await tx
                .select({ id: modelConnections.id })
                .from(modelConnections)
                .where(
                  and(
                    eq(modelConnections.workspaceId, checked.workspaceId),
                    sql`'MODEL_CONNECTION_' || upper(replace(${modelConnections.id}::text, '-', '')) = ${row.name}`,
                  ),
                )
                .orderBy(asc(modelConnections.id));
              const storage = await tx
                .select({ id: storageConnections.id })
                .from(storageConnections)
                .where(
                  and(
                    eq(storageConnections.workspaceId, checked.workspaceId),
                    sql`${STORAGE_CONNECTION_SECRET_PREFIX}::text || upper(replace(${storageConnections.id}::text, '-', '')) = ${row.name}`,
                  ),
                )
                .orderBy(asc(storageConnections.id));
              if (connectors.length > 0 || models.length > 0 || storage.length > 0) {
                return {
                  kind: 'in-use',
                  referrers: {
                    connectorIds: connectors.map((connector) => connector.id),
                    modelConnectionIds: models.map((model) => model.id),
                    storageConnectionIds: storage.map((connection) => connection.id),
                  },
                };
              }
              await tx.delete(secrets).where(within(eq(secrets.id, id)));
              return { kind: 'deleted', secret: toMetadata(row) };
            });
          } catch (error) {
            // The foreign key stays the backstop for a reference this transaction could not see.
            for (const failure of postgresViolations(error)) {
              if (
                failure.code === FOREIGN_KEY_VIOLATION &&
                SECRET_REFERENCE_CONSTRAINTS.has(failure.constraint)
              ) {
                return {
                  kind: 'in-use',
                  referrers: { connectorIds: [], modelConnectionIds: [], storageConnectionIds: [] },
                };
              }
            }
            throw error;
          }
        },
      };
    },
  };
}

/**
 * An in-memory {@link SecretsRepositoryProvider}, held to the same conformance suite as the
 * PostgreSQL one (`repository.test.ts`) so the two cannot silently drift. Envelope columns are
 * still stored — `resolve.ts` needs somewhere to read them from in a test double — but this
 * implementation's own `list`/`create`/`replace` never return them, for the same reason the
 * PostgreSQL one does not.
 */
export function createInMemorySecretsRepositoryProvider(): SecretsRepositoryProvider & {
  /** Test-only escape hatch: read a stored envelope by workspace + name, bypassing the interface
   * every route goes through. Used by `resolve.test.ts`'s in-memory half. */
  readonly _debugEnvelopes: Map<string, { metadata: SecretMetadata; envelope: SecretEnvelope }>;
} {
  const byId = new Map<string, { metadata: SecretMetadata; envelope: SecretEnvelope }>();

  return {
    _debugEnvelopes: byId,
    forScope(scope: WorkspaceScope): SecretsRepository {
      const checked = requireWorkspaceScope(scope, 'InMemorySecretsRepositoryProvider');
      const ownRows = (): { metadata: SecretMetadata; envelope: SecretEnvelope }[] =>
        [...byId.values()]
          .filter((row) => row.metadata.workspaceId === checked.workspaceId)
          .sort((a, b) => a.metadata.createdAt.getTime() - b.metadata.createdAt.getTime());

      return {
        list(): Promise<readonly SecretMetadata[]> {
          return Promise.resolve(ownRows().map((row) => row.metadata));
        },
        create(input: CreateSecretInput): Promise<CreateSecretOutcome> {
          // PostgreSQL's CHECK throws here; so does this double, so no test can store a name
          // production would refuse.
          if (!SECRET_NAME_SHAPE.test(input.name)) {
            return Promise.reject(
              new Error('the secret name violates the check constraint "secrets_name_shape"'),
            );
          }
          const conflict = ownRows().some((row) => row.metadata.name === input.name);
          if (conflict) {
            return Promise.resolve({ kind: 'name-conflict', name: input.name });
          }
          const now = new Date();
          const metadata: SecretMetadata = {
            // A real UUID, not a placeholder string: `secrets.id` is a `uuid` column in
            // PostgreSQL, and a route's `isUuid` path-parameter check would reject anything else
            // — this in-memory double must produce ids the real one could have produced.
            id: crypto.randomUUID(),
            workspaceId: checked.workspaceId,
            name: input.name,
            algorithm: input.envelope.algorithm,
            masterKeyId: input.envelope.masterKeyId,
            createdAt: now,
            updatedAt: now,
          };
          byId.set(metadata.id, { metadata, envelope: input.envelope });
          return Promise.resolve({ kind: 'created', secret: metadata });
        },
        replace(id: string, envelope: SecretEnvelope): Promise<ReplaceSecretOutcome> {
          const existing = byId.get(id);
          if (existing === undefined || existing.metadata.workspaceId !== checked.workspaceId) {
            return Promise.resolve({ kind: 'not-found' });
          }
          const metadata: SecretMetadata = {
            ...existing.metadata,
            algorithm: envelope.algorithm,
            masterKeyId: envelope.masterKeyId,
            updatedAt: new Date(),
          };
          byId.set(id, { metadata, envelope });
          return Promise.resolve({ kind: 'replaced', secret: metadata });
        },
        delete(id: string): Promise<DeleteSecretOutcome> {
          const existing = byId.get(id);
          if (existing === undefined || existing.metadata.workspaceId !== checked.workspaceId) {
            return Promise.resolve({ kind: 'not-found' });
          }
          byId.delete(id);
          return Promise.resolve({ kind: 'deleted', secret: existing.metadata });
        },
      };
    },
  };
}
