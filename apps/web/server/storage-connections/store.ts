import type {
  StorageConnectionCredential,
  StorageConnectionResource,
} from '@indx-workspace/contracts/storage-connections';
import type {
  StorageConnectionRecord,
  StorageConnectionRepository,
  StorageConnectionRepositoryProvider,
  UpdateStorageConnectionRecordInput,
  WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import type { SecretsService } from '@agent-workspace/core/secrets';

import {
  bindBareCredential,
  credentialNames,
  findSecret,
  removeConnectionSecret,
  storageConnectionSecretName,
  writeCredential,
  type SecretsContext,
  type CredentialWrite,
} from './connection-secrets';
import {
  boundCredential,
  credentialTarget,
  sealedCredential,
  storedCredential,
} from './credential-codec';
import { storageConnectionIdOf } from '../secrets';
import { log } from '../telemetry/logger';

export { storageConnectionSecretName } from './connection-secrets';
export { boundCredential, credentialTarget };

/** Everything one workspace's connection operations act on. */
type ConnectionContext = SecretsContext & {
  readonly repository: StorageConnectionRepository;
};

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

async function listConnections(ctx: ConnectionContext) {
  const [records, names] = await Promise.all([ctx.repository.list(), credentialNames(ctx)]);
  return records.map((record) =>
    toResource(record, names.has(storageConnectionSecretName(record.id))),
  );
}

async function listGrantTargets(ctx: ConnectionContext, names: readonly string[]) {
  return (await ctx.repository.listByNames(names)).map(
    ({ id, name, allowedPrefixes, writeAllowed }) => ({
      id,
      name,
      allowedPrefixes: [...allowedPrefixes],
      writeAllowed,
    }),
  );
}

async function getConnection(ctx: ConnectionContext, id: string) {
  const record = await ctx.repository.get(id);
  if (record === null) return null;
  const names = await credentialNames(ctx);
  return toResource(record, names.has(storageConnectionSecretName(id)));
}

async function readCredential(ctx: ConnectionContext, id: string, url: string) {
  const secret = await ctx.secrets.resolveByName(ctx.scope, storageConnectionSecretName(id));
  const stored = storedCredential(secret?.value);
  if (stored === null || stored.target !== null) return boundCredential(secret?.value, url);
  // A bare secret predates the binding. It counts as bound to the row as it is now, and
  // only when that row still has the snapshot's target. Nothing is written back: 0.6.11
  // reads only the bare form. `update` binds it to the old target before it moves the row;
  // a move by an older revision is why the self-hosting guide says to drain them first.
  const target = credentialTarget(url);
  const row = await ctx.repository.get(id);
  if (row === null || target === null || credentialTarget(row.url) !== target) return null;
  return stored.credential;
}

/** Seal the new connection's secret; `null` when the connection stores none. */
async function createFreshSecret(
  { secrets, scope }: ConnectionContext,
  id: string,
  input: NewStorageConnection,
): Promise<string | null> {
  // A `file` connection has nothing to authenticate with, so it stores no secret.
  const credential = input.provider === 'file' ? undefined : input.credential;
  if (credential === undefined) return null;
  const sealed = await secrets.create(scope, {
    name: storageConnectionSecretName(id),
    value: sealedCredential(input.url, credential),
  });
  if (sealed.kind !== 'created') {
    throw new Error(`fresh storage-connection secret was refused: ${sealed.kind}`);
  }
  return sealed.secret.id;
}

async function createConnection(
  ctx: ConnectionContext,
  input: NewStorageConnection,
): Promise<CreateStorageConnectionResult> {
  const id = crypto.randomUUID();
  const secretId = await createFreshSecret(ctx, id, input);
  // The secret may now exist with no row pointing at it: undo it on every path out that
  // does not finish the pair. A failed undo reaches the caller: it leaves an orphan secret,
  // never a lost row.
  const undo = async () => {
    if (secretId !== null) await ctx.secrets.delete(ctx.scope, secretId);
  };
  try {
    const outcome = await ctx.repository.create({
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
    return { kind: 'created', connection: toResource(outcome.connection, secretId !== null) };
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
}

/**
 * The target checks that run before an update changes anything: a row another writer has moved
 * since the caller's snapshot is refused, and a bare secret is bound to the old target before the
 * row moves away from it. `null` when the update may proceed.
 */
async function guardUpdate(
  ctx: ConnectionContext,
  before: StorageConnectionRecord,
  update: { id: string; snapshotUrl: string; patch: UpdateStorageConnectionRecordInput },
  hasCredential: boolean,
): Promise<TargetChanged | null> {
  const { patch, snapshotUrl } = update;
  // The caller judged the credential and the move against `snapshotUrl`.
  const guarded = hasCredential || patch.url !== undefined;
  if (guarded && credentialTarget(before.url) !== credentialTarget(snapshotUrl)) {
    return { kind: 'target-changed' };
  }
  if (patch.url !== undefined && credentialTarget(before.url) !== credentialTarget(patch.url)) {
    // A bare secret would follow the row to its new target: bind it to the old one first.
    await bindBareCredential(ctx, update.id, before.url);
  }
  return null;
}

/**
 * Replace the secret after the row changed, bound to the URL the caller judged it for, never to
 * the row read back. The row is read again just before the write: a move by another writer since
 * the check keeps that writer's secret. A move that lands after this read can only leave a secret
 * bound to another target, which every reader refuses. A failed write deletes nothing, for the
 * same reason.
 */
async function replaceCredentialAfterUpdate(
  ctx: ConnectionContext,
  write: CredentialWrite,
): Promise<{ readonly kind: 'not-found' } | TargetChanged | null> {
  const latest = await ctx.repository.get(write.id);
  if (latest === null) return { kind: 'not-found' };
  if (credentialTarget(latest.url) !== credentialTarget(write.url)) {
    return { kind: 'target-changed' };
  }
  await writeCredential(ctx, write);
  return null;
}

async function updateConnection(
  ctx: ConnectionContext,
  id: string,
  snapshotUrl: string,
  patch: UpdateStorageConnectionRecordInput,
  credential: StorageConnectionCredential | undefined,
): Promise<UpdateStorageConnectionResult> {
  const before = await ctx.repository.get(id);
  if (before === null) return { kind: 'not-found' };
  const refused = await guardUpdate(
    ctx,
    before,
    { id, snapshotUrl, patch },
    credential !== undefined,
  );
  if (refused !== null) return refused;
  const outcome = await ctx.repository.update(id, patch);
  if (outcome.kind !== 'updated') return outcome;
  if (credential !== undefined) {
    const url = patch.url ?? snapshotUrl;
    const failed = await replaceCredentialAfterUpdate(ctx, { id, url, credential });
    if (failed !== null) return failed;
  }
  const secret = await findSecret(ctx, id);
  return { kind: 'updated', connection: toResource(outcome.connection, secret !== undefined) };
}

async function rotateConnection(
  ctx: ConnectionContext,
  id: string,
  snapshotUrl: string,
  credential: StorageConnectionCredential,
): Promise<RotateStorageConnectionResult> {
  const record = await ctx.repository.get(id);
  if (record === null) return { kind: 'not-found' };
  // Bound to the snapshot the caller judged it against; a row moved since keeps its secret.
  if (credentialTarget(record.url) !== credentialTarget(snapshotUrl)) {
    return { kind: 'target-changed' };
  }
  await writeCredential(ctx, { id, url: snapshotUrl, credential });
  return { kind: 'changed', connection: toResource(record, true) };
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
async function removeOrphanSecrets({ secrets, scope, repository }: ConnectionContext) {
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

async function removeConnection(
  ctx: ConnectionContext,
  id: string,
): Promise<ChangeStorageConnectionResult> {
  // Row first, so a failure never leaves a row without its secret; a failed secret delete
  // leaves an orphan no connection names and no reader can pair with a URL. The next
  // connection delete reconciles it, and `DELETE /api/secrets/:id` can clear it too.
  const record = await ctx.repository.delete(id);
  if (record === null) return { kind: 'not-found' };
  await removeConnectionSecret(ctx, id);
  await removeOrphanSecrets(ctx);
  return { kind: 'changed', connection: toResource(record, false) };
}

function workspaceStore(
  access: () => Promise<ConnectionContext>,
): WorkspaceStorageConnectionsStore {
  return {
    list: async () => listConnections(await access()),
    listByNames: async (names) => listGrantTargets(await access(), names),
    get: async (id) => getConnection(await access(), id),
    credential: async (id, url) => readCredential(await access(), id, url),
    create: async (input) => createConnection(await access(), input),
    update: async (id, snapshotUrl, patch, credential) =>
      updateConnection(await access(), id, snapshotUrl, patch, credential),
    rotate: async (id, snapshotUrl, credential) =>
      rotateConnection(await access(), id, snapshotUrl, credential),
    remove: async (id) => removeConnection(await access(), id),
  };
}

export function createRepositoryStorageConnectionsStoreProvider(
  dependencies: RepositoryStorageConnectionsDependencies,
): StorageConnectionsStoreProvider {
  return {
    forWorkspace(workspaceId) {
      let pending: Promise<ConnectionContext> | null = null;
      const access = async () => {
        pending ??= (async () => {
          const scope = await dependencies.scopes.forWorkspaceId(workspaceId);
          if (scope === null) throw new Error(`unknown workspace ${workspaceId}`);
          return {
            secrets: dependencies.secrets,
            scope,
            repository: dependencies.repositories.forScope(scope),
          };
        })();
        return pending;
      };
      return workspaceStore(access);
    },
  };
}
