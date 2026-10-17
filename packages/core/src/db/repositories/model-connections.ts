import { and, asc, eq, type SQL } from 'drizzle-orm';

import type { Database } from '../client.js';
import { agents } from '../schema/agents.js';
import {
  modelConnections,
  parseModelConnectionConfig,
  type ModelConnectionConfig,
  type ModelProvider,
} from '../schema/model-connections.js';
import { projects } from '../schema/projects.js';
import { workspaces } from '../schema/workspaces.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';
import { postgresViolations } from './violations.js';

export interface ModelConnectionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly provider: ModelProvider;
  readonly config: ModelConnectionConfig;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateModelConnectionInput {
  readonly id: string;
  readonly name: string;
  readonly provider: ModelProvider;
  readonly config: ModelConnectionConfig;
}

export type UpdateModelConnectionPatch = Partial<
  Pick<CreateModelConnectionInput, 'name' | 'config'>
>;

export type CreateModelConnectionOutcome =
  | { readonly kind: 'created'; readonly connection: ModelConnectionRecord }
  | { readonly kind: 'name-conflict'; readonly name: string };

export type UpdateModelConnectionOutcome =
  | { readonly kind: 'updated'; readonly connection: ModelConnectionRecord }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'name-conflict'; readonly name: string };

export type DeleteModelConnectionOutcome =
  | {
      readonly kind: 'deleted';
      readonly connection: ModelConnectionRecord;
      /**
       * Every agent that pointed at this connection, named while they still can be — `agents.
       * model_connection_id` is `ON DELETE SET NULL` (schema/agents.ts), so a query issued after
       * the delete would see nothing. Read inside the same transaction as the delete itself, so
       * this list and the deletion always describe the same instant.
       *
       * Written as an inline shape, not a named exported type: `packages/core/src/db/repositories/
       * index.ts` is this wave's shared re-export barrel (owned by W9-AUTH-118 in W9.2), so this
       * task adds no new name to it. The shape still flows through `DeleteModelConnectionOutcome`,
       * which is already re-exported.
       */
      readonly referencedBy: readonly { readonly agentId: string; readonly agentName: string }[];
    }
  | { readonly kind: 'not-found' };

export interface ModelConnectionRepository {
  list(): Promise<readonly ModelConnectionRecord[]>;
  get(id: string): Promise<ModelConnectionRecord | null>;
  create(input: CreateModelConnectionInput): Promise<CreateModelConnectionOutcome>;
  update(id: string, patch: UpdateModelConnectionPatch): Promise<UpdateModelConnectionOutcome>;
  delete(id: string): Promise<DeleteModelConnectionOutcome>;
}

export interface ModelConnectionRepositoryProvider {
  forScope(scope: WorkspaceScope): ModelConnectionRepository;
}

const COLUMNS = {
  id: modelConnections.id,
  workspaceId: modelConnections.workspaceId,
  name: modelConnections.name,
  provider: modelConnections.provider,
  config: modelConnections.config,
  createdAt: modelConnections.createdAt,
  updatedAt: modelConnections.updatedAt,
} as const;

type Selected = {
  id: string;
  workspaceId: string;
  name: string;
  provider: string;
  config: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function toRecord(row: Selected): ModelConnectionRecord {
  return {
    ...row,
    provider: row.provider as ModelProvider,
    config: parseModelConnectionConfig(row.config),
  };
}

function isNameConflict(error: unknown): boolean {
  for (const failure of postgresViolations(error)) {
    if (failure.code === '23505' && failure.constraint === 'model_connections_workspace_name_key') {
      return true;
    }
  }
  return false;
}

export function createDatabaseModelConnectionRepositoryProvider(
  db: Database,
): ModelConnectionRepositoryProvider {
  return {
    forScope(scope: WorkspaceScope): ModelConnectionRepository {
      const checked = requireWorkspaceScope(scope, 'ModelConnectionRepositoryProvider');
      const tenant = eq(modelConnections.workspaceId, checked.workspaceId);
      const within = (rest: SQL): SQL => {
        const combined = and(tenant, rest);
        if (combined === undefined) throw new Error('the workspace predicate could not be built');
        return combined;
      };

      return {
        async list() {
          const rows = await db
            .select(COLUMNS)
            .from(modelConnections)
            .where(tenant)
            .orderBy(asc(modelConnections.createdAt), asc(modelConnections.id));
          return rows.map(toRecord);
        },
        async get(id) {
          const rows = await db
            .select(COLUMNS)
            .from(modelConnections)
            .where(within(eq(modelConnections.id, id)))
            .limit(1);
          return rows[0] === undefined ? null : toRecord(rows[0]);
        },
        async create(input) {
          try {
            const rows = await db
              .insert(modelConnections)
              .values({ ...input, workspaceId: checked.workspaceId })
              .returning(COLUMNS);
            if (rows[0] === undefined) throw new Error('model connection insert returned no row');
            return { kind: 'created' as const, connection: toRecord(rows[0]) };
          } catch (error) {
            if (isNameConflict(error)) return { kind: 'name-conflict', name: input.name };
            throw error;
          }
        },
        async update(id, patch) {
          if (Object.keys(patch).length === 0) {
            const existing = await this.get(id);
            return existing === null
              ? { kind: 'not-found' as const }
              : { kind: 'updated' as const, connection: existing };
          }
          try {
            const rows = await db
              .update(modelConnections)
              .set(patch)
              .where(within(eq(modelConnections.id, id)))
              .returning(COLUMNS);
            return rows[0] === undefined
              ? { kind: 'not-found' }
              : { kind: 'updated', connection: toRecord(rows[0]) };
          } catch (error) {
            if (isNameConflict(error)) return { kind: 'name-conflict', name: patch.name ?? '' };
            throw error;
          }
        },
        async delete(id) {
          // One transaction: the referencing agents are read, and the connection removed, as one
          // atomic step against this repository's own pool (issue #126's "one transaction that
          // writes the connection ... together" — see docs/adr/W9-PROV-126-atomicity-within-owns-
          // globs.md for the boundary this does and does not extend to). Reading first is required,
          // not merely tidy: `ON DELETE SET NULL` means the references are gone the instant the
          // delete below commits.
          return db.transaction(async (tx) => {
            const agentsReferencing = and(
              eq(agents.workspaceId, checked.workspaceId),
              eq(agents.modelConnectionId, id),
            );
            if (agentsReferencing === undefined) {
              throw new Error('the agents-referencing predicate could not be built');
            }
            const referenced = await tx
              .select({ id: agents.id, name: agents.name })
              .from(agents)
              .where(agentsReferencing);
            // #129: `workspaces_default_model_pair` and `projects_default_model_pair` refuse a
            // connection id without its paired model text, and the FK's own `ON DELETE SET NULL`
            // only clears the id column — it cannot also clear the paired text one. So the pair is
            // nulled here, explicitly, as one statement per table, BEFORE the connection row is
            // removed: that keeps every intermediate state the check constraint sees consistent,
            // and it is what turns "deleting a referenced connection" from a constraint violation
            // into the "recoverable, fails closed at resolution" behaviour issue #129 asks for.
            await tx
              .update(workspaces)
              .set({ defaultModelConnectionId: null, defaultModel: null })
              .where(
                and(
                  eq(workspaces.id, checked.workspaceId),
                  eq(workspaces.defaultModelConnectionId, id),
                ),
              );
            await tx
              .update(projects)
              .set({ defaultModelConnectionId: null, defaultModel: null })
              .where(
                and(
                  eq(projects.workspaceId, checked.workspaceId),
                  eq(projects.defaultModelConnectionId, id),
                ),
              );
            const rows = await tx
              .delete(modelConnections)
              .where(within(eq(modelConnections.id, id)))
              .returning(COLUMNS);
            const row = rows[0];
            if (row === undefined) return { kind: 'not-found' as const };
            return {
              kind: 'deleted' as const,
              connection: toRecord(row),
              referencedBy: referenced.map((agent) => ({
                agentId: agent.id,
                agentName: agent.name,
              })),
            };
          });
        },
      };
    },
  };
}
