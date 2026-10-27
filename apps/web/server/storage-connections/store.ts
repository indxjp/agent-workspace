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

import { log } from '../telemetry/logger';

// @story US-STO-12
export function storageConnectionSecretName(id: string): string {
  return `STORAGE_CONNECTION_${id.replace(/-/g, '').toUpperCase()}`;
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

type UpdateStorageConnectionResult =
  | { readonly kind: 'updated'; readonly connection: StorageConnectionResource }
  | { readonly kind: 'name-conflict' }
  | { readonly kind: 'not-found' };

type ChangeStorageConnectionResult =
  | { readonly kind: 'changed'; readonly connection: StorageConnectionResource }
  | { readonly kind: 'not-found' };

export interface WorkspaceStorageConnectionsStore {
  list(): Promise<readonly StorageConnectionResource[]>;
  get(id: string): Promise<StorageConnectionResource | null>;
  /**
   * The stored credential, for the server to open the connection with; it never reaches a response.
   * `null` when none is stored or the stored value is not a credential.
   */
  credential(id: string): Promise<StorageConnectionCredential | null>;
  create(input: NewStorageConnection): Promise<CreateStorageConnectionResult>;
  /** Change the row, then replace its credential when `credential` is given. */
  update(
    id: string,
    patch: UpdateStorageConnectionRecordInput,
    credential?: StorageConnectionCredential,
  ): Promise<UpdateStorageConnectionResult>;
  /** Replace the stored credential, creating the secret for a connection that had none. */
  rotate(
    id: string,
    credential: StorageConnectionCredential,
  ): Promise<ChangeStorageConnectionResult>;
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

/** Store `credential` as the connection's secret, replacing the one it had. */
async function writeCredential(
  secrets: SecretsService,
  scope: WorkspaceScope,
  id: string,
  credential: StorageConnectionCredential,
): Promise<void> {
  const value = Buffer.from(JSON.stringify(credential), 'utf8');
  const existing = await findSecret(secrets, scope, id);
  const sealed =
    existing === undefined
      ? await secrets.create(scope, { name: storageConnectionSecretName(id), value })
      : await secrets.replace(scope, existing.id, value);
  if (sealed.kind !== 'created' && sealed.kind !== 'replaced') {
    throw new Error(`the storage-connection secret was refused: ${sealed.kind}`);
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
        async get(id) {
          const { repository, scope } = await access();
          const record = await repository.get(id);
          if (record === null) return null;
          const names = await credentialNames(dependencies.secrets, scope);
          return toResource(record, names.has(storageConnectionSecretName(id)));
        },
        async credential(id) {
          const { scope } = await access();
          const stored = await dependencies.secrets.resolveByName(
            scope,
            storageConnectionSecretName(id),
          );
          if (stored === null) return null;
          try {
            const parsed = StorageConnectionCredentialSchema.safeParse(
              JSON.parse(stored.value.toString('utf8')),
            );
            return parsed.success ? parsed.data : null;
          } catch {
            return null;
          }
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
              value: Buffer.from(JSON.stringify(credential), 'utf8'),
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
        async update(id, patch, credential) {
          const { repository, scope } = await access();
          const outcome = await repository.update(id, patch);
          if (outcome.kind !== 'updated') return outcome;
          if (credential !== undefined) {
            try {
              await writeCredential(dependencies.secrets, scope, id, credential);
            } catch (error) {
              // The row may now name another host: drop the old credential rather than send it
              // there. A failed drop reaches the caller with the write's failure.
              try {
                const stale = await findSecret(dependencies.secrets, scope, id);
                if (stale !== undefined) await dependencies.secrets.delete(scope, stale.id);
              } catch (cleanup) {
                throw new AggregateError(
                  [error, cleanup],
                  'the storage connection credential was not replaced and the old one could not be removed',
                  { cause: cleanup },
                );
              }
              throw error;
            }
          }
          const secret = await findSecret(dependencies.secrets, scope, id);
          return {
            kind: 'updated',
            connection: toResource(outcome.connection, secret !== undefined),
          };
        },
        async rotate(id, credential) {
          const { repository, scope } = await access();
          const record = await repository.get(id);
          if (record === null) return { kind: 'not-found' };
          await writeCredential(dependencies.secrets, scope, id, credential);
          return { kind: 'changed', connection: toResource(record, true) };
        },
        async remove(id) {
          const { repository, scope } = await access();
          // Row first, so a failure never leaves a row without its secret; a failed secret delete
          // leaves an orphan no connection names, which `DELETE /api/secrets/:id` can clear.
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
          return { kind: 'changed', connection: toResource(record, false) };
        },
      };
    },
  };
}
