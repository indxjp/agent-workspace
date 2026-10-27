/**
 * An in-memory {@link AgentStoreProvider} — one of the two implementations the conformance suite
 * runs, and the one every other unit test in `apps/web` uses.
 *
 * It exists for two reasons and no others:
 *
 *   1. **It is half of the gate.** `store.test.ts` runs its whole conformance suite — including
 *      the cross-workspace isolation assertions §25 requires — against this *and* against
 *      `createRepositoryAgentStoreProvider` over a real PostgreSQL. That suite passing on both is
 *      the only reason to believe the two are the same thing, and neither was written by reading
 *      the other (ADR-0024 §3).
 *   2. It gives every other test in `apps/web` an agent store that needs no database.
 *
 * It is **not** a deployment mode, and `apps/web/instrumentation.ts` does not install it: agents
 * disappear when the process ends, and a deployment that did that to an operator without saying so
 * is the failure `docs/adr/W2-DB-02-no-silent-memory-fallback.md` refuses. It is kept rather than
 * deleted, for the two reasons above.
 *
 * ## The database rules it mirrors, and where they come from
 *
 * Every rule below is transcribed from `packages/core/src/db/schema/agents.ts`, so that a test
 * passing here means something about the table it stands in for:
 *
 *   * `agents_workspace_name_key` — a name is unique *within a workspace*, not globally.
 *   * `model_connection_id` REFERENCES `model_connections` — an id that names nothing is rejected.
 *   * `created_at` / `updated_at` are `timestamptz`, and `updated_at` moves on every update.
 *   * ids are database-generated; a caller never supplies one.
 */
import type { AgentPolicy, CreateAgentInput, UpdateAgentPatch } from '../../contracts/agents';
import type { AgentRecord } from './contract';
import type {
  AgentResourceAssignments,
  AgentResourceAssignmentsInput,
  AgentStoreProvider,
  CreateAgentOutcome,
  CreateAgentWithAssignmentsOutcome,
  DeleteAgentOutcome,
  ReplaceAgentPolicyOutcome,
  UpdateAgentOutcome,
  WorkspaceAgentStore,
} from './store';

export interface InMemoryAgentStoreOptions {
  /**
   * The `model_connections.id` values this store will accept, standing in for the foreign key.
   *
   * `undefined` means "do not check", which is the right default for a test that is not about
   * model connections. It is spelled as an explicit option rather than inferred from an empty set,
   * because an empty set legitimately means "this workspace has no model connections yet" and
   * must reject every non-null `modelConnectionId`.
   */
  readonly knownModelConnectionIds?: ReadonlySet<string> | undefined;
  /** The `runtime_profiles.id` values accepted by the in-memory foreign-key mirror. */
  readonly knownRuntimeProfileIds?: ReadonlySet<string> | undefined;
  /**
   * The file, skill and connector ids an assignment may name, standing in for core's existence
   * checks (`agent-resources.ts`). `undefined` means "do not check", as for model connections.
   * Skill revision pins are not checked here; `agent-resources.test.ts` holds that rule.
   */
  readonly knownAssignableIds?: ReadonlySet<string> | undefined;
  /**
   * The assignment rows `createWithAssignments` writes, keyed `${workspaceId}:${agentId}` — the
   * tables PostgreSQL shares with the resource store, so a test's resource store can read them.
   */
  readonly assignments?: Map<string, AgentResourceAssignments> | undefined;
  /** The clock. Injected so a test can make `createdAt` and `updatedAt` differ deterministically. */
  readonly now?: (() => Date) | undefined;
  /** Id generation. Injected for the same reason. Defaults to `crypto.randomUUID()`. */
  readonly newId?: (() => string) | undefined;
}

/**
 * Create a provider. The rows live in a closure, one bucket per workspace, so two stores handed out
 * by the same provider genuinely share storage — which is what makes the isolation assertions in
 * `store.test.ts` meaningful rather than tautological.
 */
export function createInMemoryAgentStoreProvider(
  options: InMemoryAgentStoreOptions = {},
): AgentStoreProvider {
  const byWorkspace = new Map<string, Map<string, AgentRecord>>();
  const now = options.now ?? ((): Date => new Date());
  const newId = options.newId ?? ((): string => crypto.randomUUID());
  const knownModelConnectionIds = options.knownModelConnectionIds;
  const knownRuntimeProfileIds = options.knownRuntimeProfileIds;

  function bucket(workspaceId: string): Map<string, AgentRecord> {
    const existing = byWorkspace.get(workspaceId);
    if (existing !== undefined) return existing;
    const created = new Map<string, AgentRecord>();
    byWorkspace.set(workspaceId, created);
    return created;
  }

  /** The `model_connection_id` foreign key, as far as an in-memory store can stand in for it. */
  function modelConnectionIsUnknown(id: string | null): boolean {
    if (id === null) return false;
    if (knownModelConnectionIds === undefined) return false;
    return !knownModelConnectionIds.has(id);
  }

  function runtimeProfileIsUnknown(id: string | null | undefined): boolean {
    if (id === null || id === undefined) return false;
    if (knownRuntimeProfileIds === undefined) return false;
    return !knownRuntimeProfileIds.has(id);
  }

  /** Core's assignment refusals, in its order: files (a duplicate is one), skills, connectors. */
  function assignmentRefusal(
    assignments: AgentResourceAssignmentsInput,
  ): Exclude<CreateAgentWithAssignmentsOutcome, { kind: 'created' }> | null {
    const known = options.knownAssignableIds;
    const seen = new Set<string>();
    for (const { fileId } of assignments.files) {
      if (seen.has(fileId) || (known !== undefined && !known.has(fileId))) {
        return { kind: 'unknown-file', id: fileId };
      }
      seen.add(fileId);
    }
    if (known === undefined) return null;
    const skill = assignments.skillIds.find((id) => !known.has(id));
    if (skill !== undefined) return { kind: 'unknown-skill', id: skill };
    const connector = assignments.connectorIds.find((id) => !known.has(id));
    if (connector !== undefined) return { kind: 'unknown-connector', id: connector };
    return null;
  }

  /** The assignments as core reads them back: sorted, deduplicated, files under `writeFiles`. */
  function storedAssignments(
    assignments: AgentResourceAssignmentsInput,
    permissions: CreateAgentInput['permissions'],
  ): AgentResourceAssignments {
    const sorted = (ids: readonly string[]): string[] => [...new Set(ids)].sort();
    const skillIds = sorted(assignments.skillIds);
    const pins = Object.entries(assignments.skillRevisions ?? {}).filter(([id]) =>
      skillIds.includes(id),
    );
    return {
      // Issue #133's ceiling: without `writeFiles` a read-write grant is stored as read.
      files: assignments.files
        .map((grant) =>
          permissions.writeFiles ? grant : { fileId: grant.fileId, access: 'read' as const },
        )
        .sort((a, b) => a.fileId.localeCompare(b.fileId)),
      skillIds,
      ...(pins.length > 0 ? { skillRevisions: Object.fromEntries(pins) } : {}),
      connectorIds: sorted(assignments.connectorIds),
      // Only a materialised version writes grants; a create with assignments starts with none.
      storageGrants: [],
    };
  }

  function nameTakenBySomeoneElse(
    rows: Map<string, AgentRecord>,
    name: string,
    exceptId: string | null,
  ): boolean {
    for (const row of rows.values()) {
      if (row.id !== exceptId && row.name === name) return true;
    }
    return false;
  }

  return {
    forWorkspace(workspaceId: string): WorkspaceAgentStore {
      // The workspace is captured here, once. Nothing below takes a workspace id, so nothing below
      // can read or write another workspace's bucket (spec §25).
      const rows = (): Map<string, AgentRecord> => bucket(workspaceId);

      /** The create, synchronously, so {@link createWithAssignments} can undo it with no gap. */
      function insert(
        input: CreateAgentInput,
        owner: { readonly principalId: string; readonly userId: string | null },
      ): CreateAgentOutcome {
        if (modelConnectionIsUnknown(input.modelConnectionId)) {
          // Narrowed by the guard: `modelConnectionIsUnknown` returns false for null.
          const id = input.modelConnectionId ?? '';
          return { kind: 'unknown-model-connection', modelConnectionId: id };
        }
        if (runtimeProfileIsUnknown(input.runtimeProfileId)) {
          return {
            kind: 'unknown-runtime-profile',
            runtimeProfileId: input.runtimeProfileId ?? '',
          };
        }
        const current = rows();
        if (nameTakenBySomeoneElse(current, input.name, null)) {
          return { kind: 'name-conflict', name: input.name };
        }
        const timestamp = now();
        const agent: AgentRecord = {
          id: newId(),
          workspaceId,
          name: input.name,
          instructions: input.instructions,
          modelConnectionId: input.modelConnectionId,
          model: input.model,
          runtimeProfileId: input.runtimeProfileId ?? null,
          permissions: { ...input.permissions },
          policy: null,
          createdBy: owner.userId,
          ownerPrincipalId: owner.principalId,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        current.set(agent.id, agent);
        return { kind: 'created', agent };
      }

      return {
        list(): Promise<readonly AgentRecord[]> {
          // Oldest first, ties broken by id, so the order is total and does not depend on insertion
          // order into the Map. A Postgres adapter must sort explicitly to match.
          const all = [...rows().values()].sort((a, b) => {
            const byTime = a.createdAt.getTime() - b.createdAt.getTime();
            return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
          });
          return Promise.resolve(all);
        },

        get(id: string): Promise<AgentRecord | null> {
          return Promise.resolve(rows().get(id) ?? null);
        },

        create(input, owner): Promise<CreateAgentOutcome> {
          return Promise.resolve(insert(input, owner));
        },

        createWithAssignments(input, owner, assignments) {
          const refusal = assignmentRefusal(assignments);
          const created = insert(input, owner);
          if (created.kind !== 'created') return Promise.resolve(created);
          if (refusal === null) {
            const stored = storedAssignments(assignments, input.permissions);
            options.assignments?.set(`${workspaceId}:${created.agent.id}`, stored);
            return Promise.resolve({ ...created, assignments: stored });
          }
          // Undone in the same synchronous turn, so no reader ever sees the row: the rollback.
          rows().delete(created.agent.id);
          return Promise.resolve(refusal);
        },

        update(id: string, patch: UpdateAgentPatch): Promise<UpdateAgentOutcome> {
          const current = rows();
          const existing = current.get(id);
          if (existing === undefined) return Promise.resolve({ kind: 'not-found' });

          const nextModelConnectionId =
            patch.modelConnectionId !== undefined
              ? patch.modelConnectionId
              : existing.modelConnectionId;
          if (modelConnectionIsUnknown(nextModelConnectionId)) {
            const connectionId = nextModelConnectionId ?? '';
            return Promise.resolve({
              kind: 'unknown-model-connection',
              modelConnectionId: connectionId,
            });
          }

          const nextRuntimeProfileId =
            patch.runtimeProfileId !== undefined
              ? patch.runtimeProfileId
              : existing.runtimeProfileId;
          if (runtimeProfileIsUnknown(nextRuntimeProfileId)) {
            return Promise.resolve({
              kind: 'unknown-runtime-profile',
              runtimeProfileId: nextRuntimeProfileId ?? '',
            });
          }

          const nextName = patch.name !== undefined ? patch.name : existing.name;
          if (nameTakenBySomeoneElse(current, nextName, id)) {
            return Promise.resolve({ kind: 'name-conflict', name: nextName });
          }

          const updated: AgentRecord = {
            id: existing.id,
            workspaceId: existing.workspaceId,
            name: nextName,
            instructions:
              patch.instructions !== undefined ? patch.instructions : existing.instructions,
            modelConnectionId: nextModelConnectionId,
            model: patch.model !== undefined ? patch.model : existing.model,
            runtimeProfileId: nextRuntimeProfileId,
            permissions:
              patch.permissions !== undefined ? { ...patch.permissions } : existing.permissions,
            policy: existing.policy,
            createdBy: existing.createdBy,
            ownerPrincipalId: existing.ownerPrincipalId,
            ...(existing.createdByAgent === undefined
              ? {}
              : { createdByAgent: existing.createdByAgent }),
            ...(existing.archivedAt === undefined ? {} : { archivedAt: existing.archivedAt }),
            createdAt: existing.createdAt,
            updatedAt: now(),
          };
          current.set(id, updated);
          return Promise.resolve({ kind: 'updated', agent: updated });
        },

        delete(id: string): Promise<DeleteAgentOutcome> {
          const removed = rows().delete(id);
          return Promise.resolve(removed ? { kind: 'deleted' } : { kind: 'not-found' });
        },

        replacePolicy(id: string, policy: AgentPolicy | null): Promise<ReplaceAgentPolicyOutcome> {
          const current = rows();
          const existing = current.get(id);
          if (existing === undefined) return Promise.resolve({ kind: 'not-found' });
          const updated: AgentRecord = { ...existing, policy, updatedAt: now() };
          current.set(id, updated);
          return Promise.resolve({ kind: 'updated', agent: updated });
        },
      };
    },
  };
}
