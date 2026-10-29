/**
 * The port the secrets routes talk to, and the adapter onto `@agent-workspace/core/secrets`.
 *
 * Copies `apps/web/server/agents/store.ts`'s shape exactly, for the same reasons that file states:
 * a store is obtained *for a workspace id* — {@link SecretsStoreProvider.forWorkspace} — and the
 * resulting {@link WorkspaceSecretsStore} has no method that takes a workspace id, so there is no
 * call site at which spec §25's tenant filter can be forgotten.
 *
 * ## `resolveByName` is not on {@link WorkspaceSecretsStore}, and that is the point
 *
 * `CoreSecretsService` (the type this adapter wraps) also carries `resolveByName`, which decrypts
 * a value. This adapter's dependency type ({@link RepositorySecretsStoreDependencies}) receives
 * the whole service, but the **port** it hands back to the routes — {@link WorkspaceSecretsStore}
 * — only declares `list`, `create`, `replace` and `remove`. There is no method on the type a route handler
 * holds that can produce a plaintext value.
 *
 * That is the type-level half. The reachability half — no non-allow-listed file in these two
 * directories can import its way to a live `CoreSecretsService`, directly or through any chain of
 * re-exports, and then call `resolveByName` on it, bypassing this port entirely — is
 * `resolve-isolation.test.ts`'s job. It checks this with the compiler (`ts.resolveModuleName`,
 * walked **transitively** — a hop through this file, through `memory-store.ts`, or through a test
 * file is followed rather than treated as a wall), not a text match; see that file's header for
 * the two counter-examples that made narrower versions of it wrong, one text-matched and one
 * one-hop. This file's own imports of `@agent-workspace/core/secrets`, immediately below, are the
 * one edge that gate must see and pass: every one of them is `import type`, so it carries no value
 * and calls nothing, and nothing else in this file re-exports or re-imports it. A
 * future task that needs to decrypt a secret server-side (spec §8, W2-CP-05) is expected to be
 * handed the full `CoreSecretsService` value directly by the composition root, the same way this
 * file is handed it — not to reach it through this port, and not by adding a value import here.
 */
import type {
  CreateSecretOutcome as CoreCreateSecretOutcome,
  DeleteSecretOutcome as CoreDeleteSecretOutcome,
  SecretReferrers as CoreSecretReferrers,
  ReplaceSecretOutcome as CoreReplaceSecretOutcome,
  SecretMetadata as CoreSecretMetadata,
  SecretsService as CoreSecretsService,
} from '@agent-workspace/core/secrets';
import {
  UnknownWorkspaceError,
  type StorageConnectionRepositoryProvider,
  type WorkspaceScope as CoreWorkspaceScope,
  type WorkspaceScopeResolver as CoreWorkspaceScopeResolver,
} from '@agent-workspace/core/db';

import { storageConnectionIdOf } from './contract';

/** One secret's metadata, as this adapter's callers see it. Mirrors `CoreSecretMetadata` exactly. */
export interface SecretRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly algorithm: string;
  readonly masterKeyId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type CreateSecretOutcome = CoreCreateSecretOutcome;
/** `in-use` is this port's own: rotating a connection's credential goes through its own route. */
export type ReplaceSecretOutcome =
  CoreReplaceSecretOutcome | { readonly kind: 'in-use'; readonly referrers: CoreSecretReferrers };
export type DeleteSecretOutcome = CoreDeleteSecretOutcome;
export type SecretReferrers = CoreSecretReferrers;

/** What `POST /api/secrets` supplies, once the wire body has been parsed and decoded to bytes. */
export interface CreateSecretInput {
  readonly name: string;
  readonly value: Buffer;
}

/**
 * Secret metadata operations for exactly one workspace. No method takes a workspace id, and no
 * method can produce a value — see this file's header for why `resolveByName` is not here.
 */
export interface WorkspaceSecretsStore {
  list(): Promise<readonly SecretRecord[]>;
  create(input: CreateSecretInput): Promise<CreateSecretOutcome>;
  /** Replace a value; the credential of a storage connection is `in-use`, its route rotates it. */
  replace(id: string, value: Buffer): Promise<ReplaceSecretOutcome>;
  /** Delete an unreferenced secret; a referenced one is `in-use` with its referrers. */
  remove(id: string): Promise<DeleteSecretOutcome>;
}

/** Hands out a {@link WorkspaceSecretsStore} bound to one workspace. */
export interface SecretsStoreProvider {
  forWorkspace(workspaceId: string): WorkspaceSecretsStore;
}

/** What {@link createRepositorySecretsStoreProvider} needs. */
export interface RepositorySecretsStoreDependencies {
  /** The whole secrets subsystem, including the decrypting method this adapter does not expose. */
  readonly service: CoreSecretsService;
  /** Turns a workspace id into a scope, or answers `null`. */
  readonly scopes: CoreWorkspaceScopeResolver;
  /** Tells a storage connection's credential from any other secret. */
  readonly storageConnections: StorageConnectionRepositoryProvider;
}

function storageConnectionInUse(connectionId: string): {
  readonly kind: 'in-use';
  readonly referrers: CoreSecretReferrers;
} {
  return {
    kind: 'in-use',
    referrers: { connectorIds: [], modelConnectionIds: [], storageConnectionIds: [connectionId] },
  };
}

/**
 * The {@link SecretsStoreProvider} backed by `@agent-workspace/core/secrets`.
 *
 * The scope lookup is memoised per `forWorkspace` call, exactly as `agents/store.ts` does it, and
 * for the same reason: one request that lists and then creates pays for one lookup, and two
 * queries in one handler cannot end up scoped to two different answers.
 */
export function createRepositorySecretsStoreProvider(
  dependencies: RepositorySecretsStoreDependencies,
): SecretsStoreProvider {
  return {
    forWorkspace(workspaceId: string): WorkspaceSecretsStore {
      let pending: Promise<CoreWorkspaceScope> | null = null;
      const scope = (): Promise<CoreWorkspaceScope> => {
        pending ??= (async (): Promise<CoreWorkspaceScope> => {
          const resolved = await dependencies.scopes.forWorkspaceId(workspaceId);
          if (resolved === null) throw new UnknownWorkspaceError(workspaceId);
          return resolved;
        })();
        return pending;
      };

      const toRecord = (secret: CoreSecretMetadata): SecretRecord => ({
        id: secret.id,
        workspaceId: secret.workspaceId,
        name: secret.name,
        algorithm: secret.algorithm,
        masterKeyId: secret.masterKeyId,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt,
      });

      /** The id of the existing storage connection whose credential secret `id` is, or `null`. */
      const liveStorageConnectionOf = async (
        resolved: CoreWorkspaceScope,
        id: string,
      ): Promise<string | null> => {
        const secret = (await dependencies.service.list(resolved)).find((row) => row.id === id);
        const connectionId = secret === undefined ? null : storageConnectionIdOf(secret.name);
        if (connectionId === null) return null;
        const connection = await dependencies.storageConnections
          .forScope(resolved)
          .get(connectionId);
        return connection === null ? null : connectionId;
      };

      return {
        async list(): Promise<readonly SecretRecord[]> {
          const secrets = await dependencies.service.list(await scope());
          return secrets.map(toRecord);
        },
        create(input: CreateSecretInput): Promise<CreateSecretOutcome> {
          return scope().then((resolved) =>
            dependencies.service.create(resolved, { name: input.name, value: input.value }),
          );
        },
        async replace(id: string, value: Buffer): Promise<ReplaceSecretOutcome> {
          const resolved = await scope();
          const connectionId = await liveStorageConnectionOf(resolved, id);
          if (connectionId !== null) return storageConnectionInUse(connectionId);
          return dependencies.service.replace(resolved, id, value);
        },
        async remove(id: string): Promise<DeleteSecretOutcome> {
          const resolved = await scope();
          // A connection's credential stays while the connection exists, whatever the service's
          // own reference check; an orphan whose connection is gone (or never was) may go.
          const connectionId = await liveStorageConnectionOf(resolved, id);
          if (connectionId !== null) return storageConnectionInUse(connectionId);
          return dependencies.service.delete(resolved, id);
        },
      };
    },
  };
}
