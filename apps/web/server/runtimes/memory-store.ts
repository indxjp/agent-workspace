/**
 * An in-memory {@link RuntimeProfileStoreProvider}, for `routes.test.ts` — the same role
 * `apps/web/server/agents/memory-store.ts` plays for the agent routes. Not a fixture of the
 * database adapter (`store.test.ts` is not written here; see this task's PR body for why): a
 * conformance suite proving the two are the same would need a real PostgreSQL either way, and that
 * coverage already exists in `packages/core/src/db/repositories/runtime-profiles.test.ts`. What
 * this buys is a fast, dependency-free way to prove the HTTP layer — status codes, JSON shapes,
 * outcome mapping — is wired correctly.
 */
import type {
  CreateRuntimeProfileInput,
  CreateRuntimeProfileOutcome,
  DeleteRuntimeProfileOutcome,
  RuntimeProfileRecord,
  RuntimeProfileStoreProvider,
  UpdateRuntimeProfileOutcome,
  UpdateRuntimeProfilePatch,
  WorkspaceRuntimeProfileStore,
} from './store';

let nextId = 1;
/** Deterministic, sortable ids — the same trick `agents/memory-store.ts` uses, for the same tests. */
function freshId(): string {
  const value = String(nextId).padStart(8, '0');
  nextId += 1;
  return `00000000-0000-4000-8000-${value}0000`;
}

export function createInMemoryRuntimeProfileStoreProvider(): RuntimeProfileStoreProvider {
  const byWorkspace = new Map<string, Map<string, RuntimeProfileRecord>>();

  return {
    forWorkspace(workspaceId: string): WorkspaceRuntimeProfileStore {
      const rows = (): Map<string, RuntimeProfileRecord> => {
        let existing = byWorkspace.get(workspaceId);
        if (existing === undefined) {
          existing = new Map();
          byWorkspace.set(workspaceId, existing);
        }
        return existing;
      };

      return {
        list(): Promise<readonly RuntimeProfileRecord[]> {
          return Promise.resolve(
            [...rows().values()].sort(
              (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
            ),
          );
        },

        get(id: string): Promise<RuntimeProfileRecord | null> {
          return Promise.resolve(rows().get(id) ?? null);
        },

        create(input: CreateRuntimeProfileInput): Promise<CreateRuntimeProfileOutcome> {
          if (
            input.runtimeConnectionId !== null &&
            input.runtimeConnectionId.startsWith('unknown')
          ) {
            return Promise.resolve({
              kind: 'unknown-runtime-connection',
              runtimeConnectionId: input.runtimeConnectionId,
            });
          }
          for (const row of rows().values()) {
            if (row.name === input.name) {
              return Promise.resolve({ kind: 'name-conflict', name: input.name });
            }
          }
          const now = new Date();
          const profile: RuntimeProfileRecord = {
            id: freshId(),
            workspaceId,
            name: input.name,
            driver: input.driver,
            runtimeConnectionId: input.runtimeConnectionId,
            cpu: input.cpu,
            memoryMb: input.memoryMb,
            diskMb: input.diskMb,
            networkPolicy: input.networkPolicy,
            allowedDomains: input.allowedDomains,
            filesystem: input.filesystem,
            persistPaths: input.persistPaths,
            timeoutSeconds: input.timeoutSeconds,
            idleTimeoutSeconds: input.idleTimeoutSeconds,
            driverConfig: input.driverConfig,
            createdAt: now,
            updatedAt: now,
          };
          rows().set(profile.id, profile);
          return Promise.resolve({ kind: 'created', profile });
        },

        update(id: string, patch: UpdateRuntimeProfilePatch): Promise<UpdateRuntimeProfileOutcome> {
          const existing = rows().get(id);
          if (existing === undefined) return Promise.resolve({ kind: 'not-found' });
          if (patch.name !== undefined && patch.name !== existing.name) {
            for (const row of rows().values()) {
              if (row.id !== id && row.name === patch.name) {
                return Promise.resolve({ kind: 'name-conflict', name: patch.name });
              }
            }
          }
          if (
            patch.runtimeConnectionId !== undefined &&
            patch.runtimeConnectionId !== null &&
            patch.runtimeConnectionId.startsWith('unknown')
          ) {
            return Promise.resolve({
              kind: 'unknown-runtime-connection',
              runtimeConnectionId: patch.runtimeConnectionId,
            });
          }
          const updated: RuntimeProfileRecord = {
            ...existing,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.driver !== undefined ? { driver: patch.driver } : {}),
            ...(patch.runtimeConnectionId !== undefined
              ? { runtimeConnectionId: patch.runtimeConnectionId }
              : {}),
            ...(patch.cpu !== undefined ? { cpu: patch.cpu } : {}),
            ...(patch.memoryMb !== undefined ? { memoryMb: patch.memoryMb } : {}),
            ...(patch.diskMb !== undefined ? { diskMb: patch.diskMb } : {}),
            ...(patch.networkPolicy !== undefined ? { networkPolicy: patch.networkPolicy } : {}),
            ...(patch.allowedDomains !== undefined ? { allowedDomains: patch.allowedDomains } : {}),
            ...(patch.filesystem !== undefined ? { filesystem: patch.filesystem } : {}),
            ...(patch.persistPaths !== undefined ? { persistPaths: patch.persistPaths } : {}),
            ...(patch.timeoutSeconds !== undefined ? { timeoutSeconds: patch.timeoutSeconds } : {}),
            ...(patch.idleTimeoutSeconds !== undefined
              ? { idleTimeoutSeconds: patch.idleTimeoutSeconds }
              : {}),
            ...(patch.driverConfig !== undefined ? { driverConfig: patch.driverConfig } : {}),
            updatedAt: new Date(),
          };
          rows().set(id, updated);
          return Promise.resolve({ kind: 'updated', profile: updated });
        },

        delete(id: string): Promise<DeleteRuntimeProfileOutcome> {
          return Promise.resolve(rows().delete(id) ? { kind: 'deleted' } : { kind: 'not-found' });
        },
      };
    },
  };
}
