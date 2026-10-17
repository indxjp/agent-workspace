import type {
  CreateModelConnectionOutcome as CoreCreateOutcome,
  DeleteModelConnectionOutcome as CoreDeleteOutcome,
  ModelConnectionRecord,
  ModelConnectionRepository,
  ModelConnectionRepositoryProvider,
  UpdateModelConnectionOutcome as CoreUpdateOutcome,
  WorkspaceScope,
  WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import type { SecretsService } from '@agent-workspace/core/secrets';

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
   * (issue #126). `false` when the connection or its secret does not exist.
   */
  replaceCredential(id: string, apiKey: string): Promise<boolean>;
  /**
   * Give a connection `apiKey` whether or not it still has a secret: rotate the secret it has, or
   * write a fresh one under its name when it has none (issue #415). First-run setup uses this to
   * repair its own row when that row's secret was lost, keeping the connection id. `false` when the
   * connection does not exist.
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
          const sealed = await dependencies.secrets.create(scope, {
            name: modelConnectionSecretName(id),
            value: Buffer.from(input.apiKey, 'utf8'),
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
          const secret = await dependencies.secrets.resolveByName(
            scope,
            modelConnectionSecretName(id),
          );
          if (secret === null) return null;
          return { connection, credential: secret.value.toString('utf8') };
        },
        async replaceCredential(id, apiKey) {
          const { repository, scope } = await access();
          if ((await repository.get(id)) === null) return false;
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
          if ((await repository.get(id)) === null) return false;
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
