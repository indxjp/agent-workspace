import type {
  CreateModelConnectionInput as CoreCreateInput,
  CreateModelConnectionOutcome as CoreCreateOutcome,
  DeleteModelConnectionOutcome as CoreDeleteOutcome,
  ModelConnectionRecord,
  ModelConnectionRepository,
  ModelConnectionRepositoryProvider,
  UpdateModelConnectionOutcome as CoreUpdateOutcome,
  UpdateModelConnectionPatch,
  WorkspaceScope,
  WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { createInMemorySecretsService, type SecretsService } from '@agent-workspace/core/secrets';
import { isKeylessProvider } from '@indx-workspace/contracts/models';

import type {
  CreateModelConnectionInput,
  ModelConnectionResource,
  UpdateModelConnectionInput,
} from './contract';
import { toModelConnectionResource } from './contract';

export function modelConnectionSecretName(id: string): string {
  return `MODEL_CONNECTION_${id.replace(/-/g, '').toUpperCase()}`;
}

/** The prefix every model-connection secret's name carries, and nothing else's. */
const MODEL_CONNECTION_SECRET_PREFIX = 'MODEL_CONNECTION_';

export type ResolvedModelConnection = {
  readonly connection: ModelConnectionRecord;
  readonly credential: string;
};

export type DeleteModelConnectionResult =
  | {
      readonly kind: 'deleted';
      readonly referencedBy: Extract<CoreDeleteOutcome, { kind: 'deleted' }>['referencedBy'];
    }
  | { readonly kind: 'not-found' };

export type ReconciliationResult = {
  /** Secret names shaped `MODEL_CONNECTION_*` with no connection row to own them (issue #126's
   * "migration/reconciliation path for already orphaned or missing model-connection secrets"). */
  readonly orphanedSecretNames: readonly string[];
};

export interface WorkspaceModelsStore {
  list(): Promise<readonly ModelConnectionResource[]>;
  get(id: string): Promise<ModelConnectionResource | null>;
  create(input: CreateModelConnectionInput): Promise<CoreCreateOutcome>;
  update(id: string, input: Omit<UpdateModelConnectionInput, 'apiKey'>): Promise<CoreUpdateOutcome>;
  delete(id: string): Promise<DeleteModelConnectionResult>;
  resolve(id: string): Promise<ResolvedModelConnection | null>;
  /**
   * Replace a connection's stored credential in place: `POST /api/model-connections/:id/credential`
   * (issue #126). `false` when the connection or its secret does not exist, or the connection is
   * keyless and stores no credential.
   */
  replaceCredential(id: string, apiKey: string): Promise<boolean>;
  /**
   * Give a connection `apiKey` whether or not it still has a secret: rotate the secret it has, or
   * write a fresh one under its name when it has none (issue #415). First-run setup uses this to
   * repair its own row when that row's secret was lost, keeping the connection id. `false` when the
   * connection does not exist or is keyless.
   */
  writeCredential(id: string, apiKey: string): Promise<boolean>;
  /** List every `MODEL_CONNECTION_*` secret this workspace holds with no connection row. */
  reconcileOrphanedCredentials(): Promise<ReconciliationResult>;
}

export interface ModelsStoreProvider {
  forWorkspace(workspaceId: string): WorkspaceModelsStore;
}

export type RepositoryModelsDependencies = {
  readonly repositories: ModelConnectionRepositoryProvider;
  readonly scopes: WorkspaceScopeResolver;
  readonly secrets: SecretsService;
};

async function credentialNames(
  secrets: SecretsService,
  scope: WorkspaceScope,
): Promise<Set<string>> {
  return new Set((await secrets.list(scope)).map((secret) => secret.name));
}

export function createRepositoryModelsStoreProvider(
  dependencies: RepositoryModelsDependencies,
): ModelsStoreProvider {
  return {
    forWorkspace(workspaceId) {
      let pending: Promise<{
        scope: WorkspaceScope;
        repository: ModelConnectionRepository;
      }> | null = null;
      const access = async () => {
        pending ??= (async () => {
          const scope = await dependencies.scopes.forWorkspaceId(workspaceId);
          if (scope === null) throw new Error(`unknown workspace ${workspaceId}`);
          return { scope, repository: dependencies.repositories.forScope(scope) };
        })();
        return pending;
      };
      const resource = async (record: ModelConnectionRecord): Promise<ModelConnectionResource> => {
        const { scope } = await access();
        const names = await credentialNames(dependencies.secrets, scope);
        return toModelConnectionResource(record, names.has(modelConnectionSecretName(record.id)));
      };

      return {
        async list() {
          const { repository, scope } = await access();
          const [records, names] = await Promise.all([
            repository.list(),
            credentialNames(dependencies.secrets, scope),
          ]);
          return records.map((record) =>
            toModelConnectionResource(record, names.has(modelConnectionSecretName(record.id))),
          );
        },
        async get(id) {
          const record = await (await access()).repository.get(id);
          return record === null ? null : resource(record);
        },
        async create(input) {
          const { repository, scope } = await access();
          const id = crypto.randomUUID();
          if (isKeylessProvider(input.provider)) {
            // A keyless connection stores no secret: there is no pair to keep whole.
            return repository.create({
              id,
              name: input.name,
              provider: input.provider,
              config: input.config,
            });
          }
          const sealed = await dependencies.secrets.create(scope, {
            name: modelConnectionSecretName(id),
            value: Buffer.from(input.apiKey ?? '', 'utf8'),
          });
          if (sealed.kind !== 'created') {
            throw new Error(`fresh model-connection secret was refused: ${sealed.kind}`);
          }
          // The secret now exists with no connection row pointing at it. Every path out of this
          // point must either finish the pair or undo the half that already landed — see
          // docs/adr/W9-PROV-126-atomicity-within-owns-globs.md for why this is a compensating
          // write plus the reconciliation query above rather than one cross-pool transaction.
          let outcome: CoreCreateOutcome;
          try {
            outcome = await repository.create({
              id,
              name: input.name,
              provider: input.provider,
              config: input.config,
            });
          } catch (error) {
            await dependencies.secrets.delete(scope, sealed.secret.id).catch(() => undefined);
            throw error;
          }
          if (outcome.kind !== 'created') {
            await dependencies.secrets.delete(scope, sealed.secret.id).catch(() => undefined);
          }
          return outcome;
        },
        async update(id, input) {
          return (await access()).repository.update(id, input);
        },
        async delete(id) {
          const { repository, scope } = await access();
          // The connection row and its referencing agents are removed as one transaction inside
          // the repository (same PostgreSQL pool). The owned secret lives on a second, separate
          // pool (`docs/adr/W2-CP-02-envelope-encryption-and-its-own-connection.md`), so it is
          // removed as a second, best-effort step: if it fails, the secret is now an orphan the
          // reconciliation query below reports and a retried delete (idempotent — the connection
          // row is already gone) or an operator can clear.
          const outcome = await repository.delete(id);
          if (outcome.kind === 'not-found') return { kind: 'not-found' };
          const name = modelConnectionSecretName(id);
          const metadata = (await dependencies.secrets.list(scope)).find(
            (candidate) => candidate.name === name,
          );
          if (metadata !== undefined) {
            await dependencies.secrets.delete(scope, metadata.id).catch(() => undefined);
          }
          return { kind: 'deleted', referencedBy: outcome.referencedBy };
        },
        async resolve(id) {
          const { repository, scope } = await access();
          const connection = await repository.get(id);
          if (connection === null) return null;
          if (isKeylessProvider(connection.provider)) return { connection, credential: '' };
          const secret = await dependencies.secrets.resolveByName(
            scope,
            modelConnectionSecretName(id),
          );
          if (secret === null) return null;
          return { connection, credential: secret.value.toString('utf8') };
        },
        async replaceCredential(id, apiKey) {
          const { repository, scope } = await access();
          const connection = await repository.get(id);
          if (connection === null || isKeylessProvider(connection.provider)) return false;
          const name = modelConnectionSecretName(id);
          const metadata = (await dependencies.secrets.list(scope)).find(
            (candidate) => candidate.name === name,
          );
          if (metadata === undefined) return false;
          const outcome = await dependencies.secrets.replace(
            scope,
            metadata.id,
            Buffer.from(apiKey, 'utf8'),
          );
          return outcome.kind === 'replaced';
        },
        async writeCredential(id, apiKey) {
          const { repository, scope } = await access();
          const connection = await repository.get(id);
          if (connection === null || isKeylessProvider(connection.provider)) return false;
          const name = modelConnectionSecretName(id);
          const value = Buffer.from(apiKey, 'utf8');
          const metadata = (await dependencies.secrets.list(scope)).find(
            (candidate) => candidate.name === name,
          );
          if (metadata !== undefined) {
            return (
              (await dependencies.secrets.replace(scope, metadata.id, value)).kind === 'replaced'
            );
          }
          return (await dependencies.secrets.create(scope, { name, value })).kind === 'created';
        },
        async reconcileOrphanedCredentials() {
          const { repository, scope } = await access();
          const [connections, names] = await Promise.all([
            repository.list(),
            credentialNames(dependencies.secrets, scope),
          ]);
          const owned = new Set(
            connections.map((connection) => modelConnectionSecretName(connection.id)),
          );
          const orphanedSecretNames = [...names].filter(
            (name) => name.startsWith(MODEL_CONNECTION_SECRET_PREFIX) && !owned.has(name),
          );
          return { orphanedSecretNames };
        },
      };
    },
  };
}

/**
 * The in-memory adapter's repository. {@link createInMemoryModelsStoreProvider} puts the repository
 * adapter above over it, with a scope resolver for the given workspaces and an in-memory secrets
 * service. Tests, the formal model and the run-delivery fixtures use it; production wires
 * {@link createRepositoryModelsStoreProvider} over PostgreSQL. It lives here because this is the
 * folder's one file that names `packages/core/db` (F-15).
 */
function inMemoryRepositories(): ModelConnectionRepositoryProvider {
  const byWorkspace = new Map<string, Map<string, ModelConnectionRecord>>();
  return {
    forScope(scope: WorkspaceScope): ModelConnectionRepository {
      let rows = byWorkspace.get(scope.workspaceId);
      if (rows === undefined) {
        rows = new Map();
        byWorkspace.set(scope.workspaceId, rows);
      }
      const current = rows;
      const conflicting = (name: string, except?: string) =>
        [...current.values()].some((row) => row.id !== except && row.name === name);
      return {
        list: () => Promise.resolve([...current.values()]),
        get: (id) => Promise.resolve(current.get(id) ?? null),
        create(input: CoreCreateInput): Promise<CoreCreateOutcome> {
          if (conflicting(input.name))
            return Promise.resolve({ kind: 'name-conflict', name: input.name });
          const now = new Date();
          const connection: ModelConnectionRecord = {
            ...input,
            workspaceId: scope.workspaceId,
            createdAt: now,
            updatedAt: now,
          };
          current.set(connection.id, connection);
          return Promise.resolve({ kind: 'created', connection });
        },
        update(id: string, patch: UpdateModelConnectionPatch): Promise<CoreUpdateOutcome> {
          const existing = current.get(id);
          if (existing === undefined) return Promise.resolve({ kind: 'not-found' });
          if (patch.name !== undefined && conflicting(patch.name, id)) {
            return Promise.resolve({ kind: 'name-conflict', name: patch.name });
          }
          const connection = { ...existing, ...patch, updatedAt: new Date() };
          current.set(id, connection);
          return Promise.resolve({ kind: 'updated', connection });
        },
        delete(id: string): Promise<CoreDeleteOutcome> {
          const connection = current.get(id);
          if (connection === undefined) return Promise.resolve({ kind: 'not-found' });
          current.delete(id);
          // This in-memory double models no `agents` table, so there is never anyone to report —
          // the real PostgreSQL repository is what `model-connections.test.ts` holds to the real
          // referencing-agents behaviour.
          return Promise.resolve({ kind: 'deleted', connection, referencedBy: [] });
        },
      };
    },
  };
}

export function createInMemoryModelsStoreProvider(
  workspaceIds: readonly string[],
): ModelsStoreProvider {
  const scopes = createInMemoryWorkspaceScopeResolver(workspaceIds.map((id) => ({ id, slug: id })));
  return createRepositoryModelsStoreProvider({
    repositories: inMemoryRepositories(),
    scopes,
    secrets: createInMemorySecretsService(),
  });
}
