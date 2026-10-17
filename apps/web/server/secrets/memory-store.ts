/**
 * An in-memory {@link SecretsStoreProvider}, for tests — the same role
 * `apps/web/server/agents/memory-store.ts` plays for the agent routes.
 *
 * Unlike that file, this one is **not** hand-rolled storage: it wraps
 * `@agent-workspace/core/secrets`'s `createInMemorySecretsService`, which does real AES-256-GCM
 * envelope encryption against an in-memory repository and a freshly generated, process-local
 * master key. So a test built on this module is exercising the real cryptographic write path —
 * `contract.ts` → `handlers.ts` → `store.ts` → the real `SecretsService` → real `sealSecret` — with
 * only PostgreSQL swapped out, which is the one part these routes cannot exercise without a
 * database at all.
 *
 * This file is a **value** importer of `@agent-workspace/core/secrets` and `@agent-workspace/core/db`
 * on purpose and without the edge-runtime caveat `store.ts`'s header explains: nothing under
 * `apps/web/instrumentation.ts` imports this module, in this task or in the established agents
 * pattern it mirrors — it exists solely for `routes.test.ts` and any other test in this directory.
 */
import { createInMemorySecretsService } from '@agent-workspace/core/secrets';
import {
  createInMemoryWorkspaceScopeResolver,
  type WorkspaceScope,
} from '@agent-workspace/core/db';

import type {
  CreateSecretInput,
  CreateSecretOutcome,
  DeleteSecretOutcome,
  ReplaceSecretOutcome,
  SecretReferrers,
  SecretRecord,
  SecretsStoreProvider,
  WorkspaceSecretsStore,
} from './store';

/**
 * `referrersOf` stands in for the references the PostgreSQL repository finds in `mcp_servers` and
 * `model_connections`: a test declares which secrets are in use, and `delete` refuses them.
 */
export function createInMemorySecretsStoreProvider(
  referrersOf: (workspaceId: string, secretId: string) => SecretReferrers | null = () => null,
): SecretsStoreProvider {
  const service = createInMemorySecretsService();

  return {
    forWorkspace(workspaceId: string): WorkspaceSecretsStore {
      // A resolver scoped to exactly this one id, minted fresh per `forWorkspace` call. It always
      // answers with a scope for `workspaceId` — the id given to it is the id asked back for —
      // so the `null` arm below is unreachable, not a real failure mode of this test double.
      const resolver = createInMemoryWorkspaceScopeResolver([
        { id: workspaceId, slug: workspaceId },
      ]);
      let pending: Promise<WorkspaceScope> | null = null;
      const scope = (): Promise<WorkspaceScope> => {
        pending ??= resolver.forWorkspaceId(workspaceId).then((resolved) => {
          if (resolved === null) {
            throw new Error(
              'unreachable: the in-memory resolver was given exactly this workspace id',
            );
          }
          return resolved;
        });
        return pending;
      };

      const toRecord = (secret: {
        readonly id: string;
        readonly workspaceId: string;
        readonly name: string;
        readonly algorithm: string;
        readonly masterKeyId: string;
        readonly createdAt: Date;
        readonly updatedAt: Date;
      }): SecretRecord => ({ ...secret });

      return {
        async list(): Promise<readonly SecretRecord[]> {
          const rows = await service.list(await scope());
          return rows.map(toRecord);
        },
        create(input: CreateSecretInput): Promise<CreateSecretOutcome> {
          return scope().then((resolved) => service.create(resolved, input));
        },
        replace(id: string, value: Buffer): Promise<ReplaceSecretOutcome> {
          return scope().then((resolved) => service.replace(resolved, id, value));
        },
        async remove(id: string): Promise<DeleteSecretOutcome> {
          const resolved = await scope();
          const owned = (await service.list(resolved)).some((secret) => secret.id === id);
          if (!owned) return { kind: 'not-found' };
          const referrers = referrersOf(workspaceId, id);
          if (referrers !== null) return { kind: 'in-use', referrers };
          return service.delete(resolved, id);
        },
      };
    },
  };
}
