import {
  StorageConnectionCredentialSchema,
  type StorageConnectionCredential,
  type StorageConnectionResource,
} from '@indx-workspace/contracts/storage-connections';
import type {
  StorageConnectionRecord,
  StorageConnectionRepository,
  StorageConnectionRepositoryProvider,
  UpdateStorageConnectionRecordInput,
  WorkspaceScope,
  WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import type { SecretsService } from '@agent-workspace/core/secrets';
import { parseStorageUrl } from '@indx-workspace/contracts/storage-url';
import { z } from 'zod';

import { STORAGE_CONNECTION_SECRET_PREFIX, storageConnectionIdOf } from '../secrets/contract';
import { log } from '../telemetry/logger';

// @story US-STO-12
export function storageConnectionSecretName(id: string): string {
  return `${STORAGE_CONNECTION_SECRET_PREFIX}${id.replace(/-/g, '').toUpperCase()}`;
}

/** Where a URL's credential is sent: everything the URL names but its prefix. */
export function credentialTarget(url: string): string | null {
  const parsed = parseStorageUrl(url);
  return parsed.ok ? JSON.stringify({ ...parsed.location, prefix: '' }) : null;
}

// The stored secret is the credential sealed with the target it was supplied for, so a reader can
// never pair it with another endpoint. A secret written before this binding is the bare credential.
const BoundCredentialSchema = z
  .object({ target: z.string(), credential: StorageConnectionCredentialSchema })
  .strict();

type StoredCredential = {
  readonly target: string | null;
  readonly credential: StorageConnectionCredential;
};

function storedCredential(value: Buffer | undefined): StoredCredential | null {
  if (value === undefined) return null;
  let json: unknown;
  try {
    json = JSON.parse(value.toString('utf8'));
  } catch {
    return null;
  }
  const bound = BoundCredentialSchema.safeParse(json);
  if (bound.success) return bound.data;
  const bare = StorageConnectionCredentialSchema.safeParse(json);
  return bare.success ? { target: null, credential: bare.data } : null;
}

/**
 * The credential in a stored secret, only when it was bound to `url`'s target: `null` for a secret
 * bound to another target, a bare (pre-binding) credential, a value that is no credential, or a URL
 * naming no target. Nothing here quotes the stored value.
 */
export function boundCredential(
  value: Buffer | undefined,
  url: string,
): StorageConnectionCredential | null {
  const stored = storedCredential(value);
  const target = credentialTarget(url);
  return stored !== null && stored.target !== null && target !== null && stored.target === target
    ? stored.credential
    : null;
}

function sealedCredential(url: string, credential: StorageConnectionCredential): Buffer {
  // An unparseable URL binds to '', which no URL's target equals: the secret then fails closed.
  const target = credentialTarget(url) ?? '';
  return Buffer.from(JSON.stringify({ target, credential }), 'utf8');
}

type NewStorageConnection = {
  readonly name: string;
  readonly url: string;
  readonly provider: StorageConnectionRecord['provider'];
  readonly allowedPrefixes: readonly string[];
  readonly writeAllowed: boolean;
  readonly credential: StorageConnectionCredential | undefined;
};

type CreateStorageConnectionResult =
  | { readonly kind: 'created'; readonly connection: StorageConnectionResource }
  | { readonly kind: 'name-conflict' };

/** Another writer moved the row off the caller's snapshot target; no secret was written. */
type TargetChanged = { readonly kind: 'target-changed' };

type UpdateStorageConnectionResult =
  | { readonly kind: 'updated'; readonly connection: StorageConnectionResource }
  | { readonly kind: 'name-conflict' }
  | { readonly kind: 'not-found' }
  | TargetChanged;

type ChangeStorageConnectionResult =
  | { readonly kind: 'changed'; readonly connection: StorageConnectionResource }
  | { readonly kind: 'not-found' };

type RotateStorageConnectionResult = ChangeStorageConnectionResult | TargetChanged;

/** What a deploy-time grant check reads of a connection: no credential, no secret name. */
type StorageConnectionGrantTarget = Pick<
  StorageConnectionRecord,
  'id' | 'name' | 'allowedPrefixes' | 'writeAllowed'
>;

export interface WorkspaceStorageConnectionsStore {
  list(): Promise<readonly StorageConnectionResource[]>;
  /** The named connections of the workspace, for a grant check; it reads no secret. */
  listByNames(names: readonly string[]): Promise<readonly StorageConnectionGrantTarget[]>;
  get(id: string): Promise<StorageConnectionResource | null>;
  /**
   * The stored credential, for the server to open the connection with; it never reaches a response.
   * `url` is the row snapshot the caller will open: `null` when no credential is stored, the stored
   * value is not a credential, or it was supplied for another endpoint, account or bucket. A bare
   * (pre-binding) secret is returned only while the row still has `url`'s target; it is bound to
   * that target in memory and never written back, so an older revision can still read it. Only
   * `create`, `update` and `rotate` write a secret.
   */
  credential(id: string, url: string): Promise<StorageConnectionCredential | null>;
  create(input: NewStorageConnection): Promise<CreateStorageConnectionResult>;
  /**
   * Change the row, then replace its credential when `credential` is given. `snapshotUrl` is the
   * URL the caller judged the patch against; the credential is bound to `patch.url ?? snapshotUrl`.
   * A row whose target is no longer the snapshot's is `target-changed` and its secret is untouched.
   */
  update(
    id: string,
    snapshotUrl: string,
    patch: UpdateStorageConnectionRecordInput,
    credential?: StorageConnectionCredential,
  ): Promise<UpdateStorageConnectionResult>;
  /**
   * Replace the stored credential, bound to `snapshotUrl`, creating the secret for a connection that
   * had none. A row whose target is no longer the snapshot's is `target-changed`, untouched.
   */
  rotate(
    id: string,
    snapshotUrl: string,
    credential: StorageConnectionCredential,
  ): Promise<RotateStorageConnectionResult>;
  /** Delete the row, then its secret; the removed connection is returned. */
  remove(id: string): Promise<ChangeStorageConnectionResult>;
}

export interface StorageConnectionsStoreProvider {
  forWorkspace(workspaceId: string): WorkspaceStorageConnectionsStore;
}

export type RepositoryStorageConnectionsDependencies = {
  readonly repositories: StorageConnectionRepositoryProvider;
  readonly scopes: WorkspaceScopeResolver;
  readonly secrets: SecretsService;
};

function toResource(
  record: StorageConnectionRecord,
  hasCredential: boolean,
): StorageConnectionResource {
  return {
    id: record.id,
    name: record.name,
    provider: record.provider,
    url: record.url,
    allowedPrefixes: [...record.allowedPrefixes],
    writeAllowed: record.writeAllowed,
    hasCredential,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function credentialNames(secrets: SecretsService, scope: WorkspaceScope) {
  return new Set((await secrets.list(scope)).map((secret) => secret.name));
}

async function findSecret(secrets: SecretsService, scope: WorkspaceScope, id: string) {
  const name = storageConnectionSecretName(id);
  return (await secrets.list(scope)).find((secret) => secret.name === name);
}

/**
 * Store `credential`, bound to `url`, as the connection's secret, replacing the one it had. With
 * `onlyOver`, the write happens only while the stored value is still exactly those bytes, read
 * again just before the write: `skipped` when another writer has replaced it since.
 */
async function writeCredential(
  secrets: SecretsService,
  scope: WorkspaceScope,
  id: string,
  url: string,
  credential: StorageConnectionCredential,
  onlyOver?: Buffer,
): Promise<'written' | 'skipped'> {
  const value = sealedCredential(url, credential);
  const existing = await findSecret(secrets, scope, id);
  if (onlyOver !== undefined) {
    const current = await secrets.resolveByName(scope, storageConnectionSecretName(id));
    if (existing === undefined || current === null || !current.value.equals(onlyOver)) {
      return 'skipped';
    }
  }
  const sealed =
    existing === undefined
      ? await secrets.create(scope, { name: storageConnectionSecretName(id), value })
      : await secrets.replace(scope, existing.id, value);
  if (sealed.kind !== 'created' && sealed.kind !== 'replaced') {
    throw new Error(`the storage-connection secret was refused: ${sealed.kind}`);
  }
  return 'written';
}

/** Bind a pre-binding (bare) secret to `url`, so a later change of the row's target cannot carry it. */
async function bindBareCredential(
  secrets: SecretsService,
  scope: WorkspaceScope,
  id: string,
  url: string,
): Promise<void> {
  const secret = await secrets.resolveByName(scope, storageConnectionSecretName(id));
  const stored = storedCredential(secret?.value);
  // Only over the same bare bytes: a rotation since the read above is never undone.
  if (secret !== null && stored !== null && stored.target === null) {
    await writeCredential(secrets, scope, id, url, stored.credential, secret.value);
  }
}

/**
 * How long a connection secret with no connection row is left alone before a reconcile removes
 * it. `create` writes the secret before its row, so a younger secret may belong to a connection
 * still being created.
 */
export const ORPHAN_CONNECTION_SECRET_GRACE_MS = 10 * 60 * 1000;

/**
 * Remove the connection secrets no row names any more and that are older than
 * {@link ORPHAN_CONNECTION_SECRET_GRACE_MS}: what a failed secret delete after a connection
 * DELETE left behind. Best effort: a failure is logged and retried by the next delete.
 */
async function removeOrphanSecrets(
  secrets: SecretsService,
  scope: WorkspaceScope,
  repository: StorageConnectionRepository,
): Promise<void> {
  try {
    const [stored, rows] = await Promise.all([secrets.list(scope), repository.list()]);
    const owned = new Set(rows.map((row) => row.id));
    const cutoff = Date.now() - ORPHAN_CONNECTION_SECRET_GRACE_MS;
    for (const secret of stored) {
      const connectionId = storageConnectionIdOf(secret.name);
      if (connectionId === null || owned.has(connectionId)) continue;
      if (secret.updatedAt.getTime() > cutoff) continue;
      const outcome = await secrets.delete(scope, secret.id);
      if (outcome.kind === 'deleted') {
        log.info('[storage-connections] removed the secret of a deleted connection', {
          connectionId,
        });
      }
    }
  } catch (error) {
    log.error('[storage-connections] orphan connection secrets could not be reconciled', {
      error,
    });
  }
}

export function createRepositoryStorageConnectionsStoreProvider(
  dependencies: RepositoryStorageConnectionsDependencies,
): StorageConnectionsStoreProvider {
  return {
    forWorkspace(workspaceId) {
      let pending: Promise<{
        scope: WorkspaceScope;
        repository: StorageConnectionRepository;
      }> | null = null;
      const access = async () => {
        pending ??= (async () => {
          const scope = await dependencies.scopes.forWorkspaceId(workspaceId);
          if (scope === null) throw new Error(`unknown workspace ${workspaceId}`);
          return { scope, repository: dependencies.repositories.forScope(scope) };
        })();
        return pending;
      };

      return {
        async list() {
          const { repository, scope } = await access();
          const [records, names] = await Promise.all([
            repository.list(),
            credentialNames(dependencies.secrets, scope),
          ]);
          return records.map((record) =>
            toResource(record, names.has(storageConnectionSecretName(record.id))),
          );
        },
        async listByNames(names) {
          const { repository } = await access();
          return (await repository.listByNames(names)).map(
            ({ id, name, allowedPrefixes, writeAllowed }) => ({
              id,
              name,
              allowedPrefixes: [...allowedPrefixes],
              writeAllowed,
            }),
          );
        },
        async get(id) {
          const { repository, scope } = await access();
          const record = await repository.get(id);
          if (record === null) return null;
          const names = await credentialNames(dependencies.secrets, scope);
          return toResource(record, names.has(storageConnectionSecretName(id)));
        },
        async credential(id, url) {
          const { repository, scope } = await access();
          const name = storageConnectionSecretName(id);
          const secret = await dependencies.secrets.resolveByName(scope, name);
          const stored = storedCredential(secret?.value);
          if (stored === null || stored.target !== null) return boundCredential(secret?.value, url);
          // A bare secret predates the binding. It counts as bound to the row as it is now, and
          // only when that row still has the snapshot's target. Nothing is written back: 0.6.11
          // reads only the bare form. `update` binds it to the old target before it moves the row;
          // a move by an older revision is why the self-hosting guide says to drain them first.
          const target = credentialTarget(url);
          const row = await repository.get(id);
          if (row === null || target === null || credentialTarget(row.url) !== target) return null;
          return stored.credential;
        },
        async create(input) {
          const { repository, scope } = await access();
          const id = crypto.randomUUID();
          // A `file` connection has nothing to authenticate with, so it stores no secret.
          const credential = input.provider === 'file' ? undefined : input.credential;
          let secretId: string | null = null;
          if (credential !== undefined) {
            const sealed = await dependencies.secrets.create(scope, {
              name: storageConnectionSecretName(id),
              value: sealedCredential(input.url, credential),
            });
            if (sealed.kind !== 'created') {
              throw new Error(`fresh storage-connection secret was refused: ${sealed.kind}`);
            }
            secretId = sealed.secret.id;
          }
          // The secret may now exist with no row pointing at it: undo it on every path out that
          // does not finish the pair. A failed undo reaches the caller: it leaves an orphan secret,
          // never a lost row.
          const undo = async () => {
            if (secretId !== null) await dependencies.secrets.delete(scope, secretId);
          };
          try {
            const outcome = await repository.create({
              id,
              name: input.name,
              provider: input.provider,
              url: input.url,
              allowedPrefixes: input.allowedPrefixes,
              writeAllowed: input.writeAllowed,
            });
            if (outcome.kind === 'name-conflict') {
              await undo();
              return { kind: 'name-conflict' };
            }
            return {
              kind: 'created',
              connection: toResource(outcome.connection, secretId !== null),
            };
          } catch (error) {
            try {
              await undo();
            } catch (cleanup) {
              throw new AggregateError(
                [error, cleanup],
                'the storage connection was not created and its secret could not be removed',
                { cause: cleanup },
              );
            }
            throw error;
          }
        },
        async update(id, snapshotUrl, patch, credential) {
          const { repository, scope } = await access();
          const before = await repository.get(id);
          if (before === null) return { kind: 'not-found' };
          // The caller judged the credential and the move against `snapshotUrl`. A row another
          // writer has moved since is refused before anything changes.
          const guarded = credential !== undefined || patch.url !== undefined;
          if (guarded && credentialTarget(before.url) !== credentialTarget(snapshotUrl)) {
            return { kind: 'target-changed' };
          }
          if (
            patch.url !== undefined &&
            credentialTarget(before.url) !== credentialTarget(patch.url)
          ) {
            // A bare secret would follow the row to its new target: bind it to the old one first.
            await bindBareCredential(dependencies.secrets, scope, id, before.url);
          }
          const outcome = await repository.update(id, patch);
          if (outcome.kind !== 'updated') return outcome;
          if (credential !== undefined) {
            // Bound to the URL the caller judged it for, never to the row read back. The row is
            // read again just before the write: a move by another writer since the check above
            // keeps that writer's secret. A move that lands after this read can only leave a
            // secret bound to another target, which every reader refuses. A failed write deletes
            // nothing, for the same reason.
            const boundUrl = patch.url ?? snapshotUrl;
            const latest = await repository.get(id);
            if (latest === null) return { kind: 'not-found' };
            if (credentialTarget(latest.url) !== credentialTarget(boundUrl)) {
              return { kind: 'target-changed' };
            }
            await writeCredential(dependencies.secrets, scope, id, boundUrl, credential);
          }
          const secret = await findSecret(dependencies.secrets, scope, id);
          return {
            kind: 'updated',
            connection: toResource(outcome.connection, secret !== undefined),
          };
        },
        async rotate(id, snapshotUrl, credential) {
          const { repository, scope } = await access();
          const record = await repository.get(id);
          if (record === null) return { kind: 'not-found' };
          // Bound to the snapshot the caller judged it against; a row moved since keeps its secret.
          if (credentialTarget(record.url) !== credentialTarget(snapshotUrl)) {
            return { kind: 'target-changed' };
          }
          await writeCredential(dependencies.secrets, scope, id, snapshotUrl, credential);
          return { kind: 'changed', connection: toResource(record, true) };
        },
        async remove(id) {
          const { repository, scope } = await access();
          // Row first, so a failure never leaves a row without its secret; a failed secret delete
          // leaves an orphan no connection names and no reader can pair with a URL. The next
          // connection delete reconciles it, and `DELETE /api/secrets/:id` can clear it too.
          const record = await repository.delete(id);
          if (record === null) return { kind: 'not-found' };
          try {
            const secret = await findSecret(dependencies.secrets, scope, id);
            if (secret !== undefined) {
              const outcome = await dependencies.secrets.delete(scope, secret.id);
              if (outcome.kind !== 'deleted') {
                log.error(
                  '[storage-connections] the secret of a deleted connection was not removed',
                  { connectionId: id, outcome: outcome.kind },
                );
              }
            }
          } catch (error) {
            log.error('[storage-connections] the secret of a deleted connection was not removed', {
              connectionId: id,
              error,
            });
          }
          await removeOrphanSecrets(dependencies.secrets, scope, repository);
          return { kind: 'changed', connection: toResource(record, false) };
        },
      };
    },
  };
}
