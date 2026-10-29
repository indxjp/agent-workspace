/**
 * An in-memory {@link AgentVersionStoreProvider}, for the memory-store route tests and the dryRun
 * parity test (S1-05, issue #443). It is not a deployment store: `register.ts` wires the
 * repository-backed one, and `app/api/agents/[id]/versions/versions.postgres.test.ts` proves the
 * real rules against PostgreSQL.
 *
 * It resolves names with core's own pure rule, `resolveFromRows` (C7, missing and ambiguous, the
 * workspace default runtime profile), against the rows {@link InMemoryAgentVersionStoreOptions}
 * seeds, and narrows file grants with core's `narrowFileGrants` (#133), so neither rule is restated.
 *
 * S1-06 (issue #444) adds the writes core does in one transaction — `applyAndPoint` and
 * `createAgentWithFirstVersion` — as a documented mirror. Every refusal is checked **before**
 * anything is mutated, so a refused write leaves no partial row, as core's rollback does:
 *
 * - the agent and the version exist (`not-found`, `version-not-found`);
 * - the agent name is free in the workspace, the `agents_workspace_name_key` mirror
 *   (`name-conflict`);
 * - **one level of subagents**, both ways (`subagent-nesting`, core's check in its materialising
 *   transactions: `local` moves and creates only);
 * - **C9**: no surface name of the version is served by a version another agent of the workspace
 *   points the same environment at (`surface-name-taken`, the first such name in sorted order);
 * - the principals are known (`unknown-principal`, create only).
 *
 * The agent row is then written through the in-memory agent store (`update`/`create` and
 * `replacePolicy`), and the assignments are kept in a map a test reads with `assignmentsOf`. As in
 * core, only a `local` move writes them (issue #612): a `production` move moves its pointer alone,
 * so it cannot meet `name-conflict`.
 *
 * An applied `applyAndPoint` also records the move's `agent-changed` audit row (issue #478), and a
 * create given `agentCreatedAudit` its `agent-created` row (built and parsed before the create writes
 * anything), with the workspace, action and subject fixed from the call as core fixes them; a test
 * reads the rows with `audits`. A refusal records none. Every pointer write also appends to the pointer history
 * (issue #615), which `listMoves` answers newest first in insertion order. The audit table's own constraints (the actor-principal
 * foreign key, the not-blank labels) are not mirrored: only PostgreSQL can prove that a refused
 * audit row rolls the move back, and `pointers.postgres.test.ts` does.
 */
import {
  AgentCreatedAuditDetailsSchema,
  type AgentCreatedAuditDetails,
} from '@indx-workspace/contracts/observability';

import {
  appliedRuntimeProfileId,
  bodyDeclaresSubagents,
  bodyHasDescription,
  bodySubagentNames,
  narrowFileGrants,
  narrowStorageGrants,
  storageGrantChange,
  type StorageGrantRef,
  resolveFromRows,
  type AgentDefinitionReferenceKind,
  type AgentPointerAudit,
  type AgentPointerMoveReason,
  type AgentPointerMoveRecord,
  type AgentVersionEnvironment,
  type AgentVersionListing,
  type AgentVersionPointerRecord,
  type AgentSubagentCandidate,
  type AgentVersionStoreProvider,
  type AgentVersionRecord,
  type ApplyAndPointOutcome,
  type CreateAgentVersionInput,
  type CreateAgentVersionOutcome,
  type CreateAgentWithFirstVersionOutcome,
  type FileGrant,
  type MaterialisedAgent,
  type PointedSurface,
  type ReferenceNames,
  type ResolveDefinitionOutcome,
  type WorkspaceAgentVersionStore,
} from './store';

import {
  toStoredPolicy,
  type AgentStoreProvider,
  type WorkspaceAgentStore,
  type CreateAgentOutcome,
  type UpdateAgentOutcome,
} from '../agents/store';
import type { AgentResourceStoreProvider } from '../agents/resource-store';
import type { LatestEvaluation } from './release';

/** A row a definition name may match: its id and the name (a file's path) it is known by. */
export interface SeededReference {
  readonly id: string;
  readonly name: string;
  /** A connector that launches a process (`transport: stdio`), not one reached over a URL. */
  readonly stdio?: boolean;
  /** A tool connector (`openapi`/`postgres`), not an MCP one. */
  readonly tool?: boolean;
  /** A skill whose delete is under way: it does not resolve and answers `skill_deleting`. */
  readonly deleting?: boolean;
}

/** The rows each reference kind may match, for one workspace. */
export type SeededReferences = Partial<
  Record<AgentDefinitionReferenceKind, readonly SeededReference[]>
>;

export interface InMemoryAgentVersionStoreOptions {
  /** The agents a version may belong to — `create` and `list` answer "no agent" for any other id. */
  readonly agents: AgentStoreProvider;
  /**
   * The legacy assignment store a route test reads, which a `local` materialisation also writes —
   * in PostgreSQL both read the same three tables (issue #616).
   */
  readonly resources?: AgentResourceStoreProvider;
  /** The named rows each workspace holds, keyed by workspace id. */
  readonly references?: Readonly<Record<string, SeededReferences>>;
  /**
   * Each workspace's default runtime profile id (the profile marked `runtime_profiles.workspace_default`), keyed by
   * workspace id. A workspace absent here has no default, so a null `runtimeProfileName` resolves
   * to `null`.
   */
  readonly defaultRuntimeProfiles?: Readonly<Record<string, string>>;
  /** The principal ids `create` accepts; `undefined` accepts any (the foreign-key mirror). */
  readonly knownPrincipalIds?: ReadonlySet<string>;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** A pointer row as the memory store keeps it: the record plus its workspace. */
export type SeededPointer = AgentVersionPointerRecord & { readonly workspaceId: string };

/** An `agent-changed` audit row as the memory store records it — the `audit_events` mirror. */
export type RecordedPointerAudit = AgentPointerAudit & {
  readonly workspaceId: string;
  readonly action: 'agent-changed' | 'storage-grant-changed' | 'agent-created';
  readonly subjectId: string;
  /** Set on an `agent-created` row only. */
  readonly details?: AgentCreatedAuditDetails;
};

/** The provider plus what a test reads back: how many versions and pointers exist. */
export interface InMemoryAgentVersionStoreProvider extends AgentVersionStoreProvider {
  /** Every version row in every workspace. */
  versionCount(): number;
  /** Every pointer row in every workspace. */
  pointerCount(): number;
  /** Every `agent-changed` row an applied pointer move recorded, oldest first. */
  audits(): readonly RecordedPointerAudit[];
  /**
   * Seed a pointer directly, without materialising the version (a listing test's shortcut). It
   * records a `set` move with no mover, as the migration's backfill does.
   */
  point(pointer: SeededPointer): void;
  /** The assignments the last materialisation wrote for `agentId`, or `undefined` if none. */
  assignmentsOf(agentId: string): MaterialisedAssignments | undefined;
  /** Seed an evaluation of the version with id `versionId`; the newest seeded is the latest. */
  recordEvaluation(versionId: string, evaluation: LatestEvaluation): void;
}

/** What a materialisation writes beside the agent row: core's three assignment tables. */
export interface MaterialisedAssignments {
  readonly skillIds: readonly string[];
  readonly skillRevisions?: Readonly<Record<string, number>> | undefined;
  readonly connectorIds: readonly string[];
  /** After the #133 ceiling: `read-write` only when the agent may write files. */
  readonly files: readonly FileGrant[];
  /** After the same ceiling, with the connection ids the deploy resolved. */
  readonly storageGrants: readonly StorageGrantRef[];
}

/** A folder listed twice keeps one grant, as the table's unique key does. */
function distinctFolders(grants: readonly StorageGrantRef[]): readonly StorageGrantRef[] {
  return [
    ...new Map(grants.map((grant) => [`${grant.connectionId}\n${grant.prefix}`, grant])).values(),
  ];
}

/** Core's `writeAssignments`: one row per id, file and storage grants under the #133 ceiling. */
function toAssignments(agent: MaterialisedAgent): MaterialisedAssignments {
  return {
    skillIds: [...new Set(agent.references.skillIds)],
    skillRevisions: agent.references.skillRevisions,
    connectorIds: [...new Set(agent.references.connectorIds)],
    files: narrowFileGrants(agent.references.files, agent.permissions),
    storageGrants: narrowStorageGrants(agent.references.storageGrants ?? [], agent.permissions),
  };
}

/** One element of a stored body's `surfaces`, as core's SQL reads it: anything with a name. */
interface StoredSurface {
  readonly name: string;
  readonly element: unknown;
}

/** `body.surfaces` read the way core's SQL does: a non-array is no surfaces, a nameless one skipped. */
function surfacesOf(body: unknown): readonly StoredSurface[] {
  if (typeof body !== 'object' || body === null || !('surfaces' in body)) return [];
  const surfaces: unknown = body.surfaces;
  if (!Array.isArray(surfaces)) return [];
  return surfaces.flatMap((element: unknown) => {
    if (typeof element !== 'object' || element === null || !('name' in element)) return [];
    const name: unknown = element.name;
    return typeof name === 'string' ? [{ name, element }] : [];
  });
}

/** An agent-store refusal on a materialising write, as the core outcome it stands in for. */
/** The seeded rows, with the skills being deleted moved out of `skill` (they do not resolve). */
function deletingSkillsApart(seeded: SeededReferences) {
  const skills = seeded.skill ?? [];
  return {
    ...seeded,
    skill: skills.filter((row) => row.deleting !== true),
    deletingSkill: skills.filter((row) => row.deleting === true),
  };
}

function agentWriteRefusal(
  outcome: Exclude<
    UpdateAgentOutcome | CreateAgentOutcome,
    { readonly kind: 'updated' | 'created' }
  >,
):
  | { readonly kind: 'not-found' }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | { readonly kind: 'reference-gone'; readonly referenceKind: AgentDefinitionReferenceKind } {
  switch (outcome.kind) {
    case 'not-found':
      return { kind: 'not-found' };
    case 'name-conflict':
      return { kind: 'name-conflict', name: outcome.name };
    case 'unknown-model-connection':
      return { kind: 'reference-gone', referenceKind: 'model-connection' };
    case 'unknown-runtime-profile':
      return { kind: 'reference-gone', referenceKind: 'runtime-profile' };
  }
}

/** The agent-row columns a materialisation sets, in the agent store's patch shape. */
function rowOf(agent: MaterialisedAgent): {
  readonly name: string;
  readonly instructions: string;
  readonly model: string | null;
  readonly modelConnectionId: string | null;
  readonly runtimeProfileId: string | null;
  readonly permissions: MaterialisedAgent['permissions'];
} {
  return {
    name: agent.name,
    instructions: agent.instructions,
    model: agent.model,
    modelConnectionId: agent.references.modelConnectionId,
    runtimeProfileId: agent.references.runtimeProfileId,
    permissions: { ...agent.permissions },
  };
}

/**
 * The `agent-created` row of a create, parsed before the create writes anything; the new agent's id
 * does not exist yet, so the caller replaces the `PENDING` ids once it does. Null without the input.
 */
const PENDING = 'pending';
function createdAuditRow(
  workspaceId: string,
  input: Parameters<WorkspaceAgentVersionStore['createAgentWithFirstVersion']>[0],
): (RecordedPointerAudit & { readonly details: AgentCreatedAuditDetails }) | null {
  if (input.agentCreatedAudit === undefined) return null;
  const { details, ...actor } = input.agentCreatedAudit;
  return {
    ...actor,
    workspaceId,
    action: 'agent-created',
    subjectId: PENDING,
    subjectLabel: input.agent.name,
    details: AgentCreatedAuditDetailsSchema.parse({
      ...details,
      agentId: PENDING,
      version: 1,
      via: input.version.via,
    }),
  };
}

/** Create the in-memory provider. Versions, pointers and assignments live in this closure. */
export function createInMemoryAgentVersionStoreProvider(
  options: InMemoryAgentVersionStoreOptions,
): InMemoryAgentVersionStoreProvider {
  const versions: AgentVersionRecord[] = [];
  const pointers: SeededPointer[] = [];
  const audits: RecordedPointerAudit[] = [];
  /** The pointer history, oldest first. */
  const moves: (AgentPointerMoveRecord & {
    readonly workspaceId: string;
    readonly agentId: string;
  })[] = [];
  const assignments = new Map<string, MaterialisedAssignments>();
  /** Each version's own storage grants, by version id (`agent_version_storage_grants`). */
  const versionGrants = new Map<string, readonly StorageGrantRef[]>();
  /** The newest evaluation of each version id; a version id is unique across workspaces. */
  const evaluations = new Map<string, LatestEvaluation>();
  // ponytail: an edit is detected as a moved `updatedAt`, because the in-memory agent store has no
  // `materialised_version_id` to clear. `agent-materialised-version.test.ts` proves the real rule
  // against PostgreSQL.
  const writtenFrom = new Map<string, { versionId: string; agentUpdatedAt: number }>();
  const now = options.now ?? ((): Date => new Date());
  const countCreatedSince = async (
    workspaceAgents: Pick<WorkspaceAgentStore, 'list'>,
    since: Date,
  ): Promise<number> =>
    (await workspaceAgents.list()).filter(
      (agent) => agent.builtin === undefined && agent.createdAt >= since,
    ).length;
  const newId = options.newId ?? ((): string => crypto.randomUUID());
  const principalIsUnknown = (principalId: string): boolean =>
    options.knownPrincipalIds !== undefined && !options.knownPrincipalIds.has(principalId);

  /** Insert or move the pointer of one agent and environment, and append the move (core's). */
  const movePointer = (
    pointer: SeededPointer,
    reason: AgentPointerMoveReason,
    movedByPrincipalId: string | null,
  ): AgentVersionPointerRecord => {
    const index = pointers.findIndex(
      (row) =>
        row.workspaceId === pointer.workspaceId &&
        row.agentId === pointer.agentId &&
        row.environment === pointer.environment,
    );
    if (index === -1) pointers.push(pointer);
    else pointers.splice(index, 1, pointer);
    moves.push({
      workspaceId: pointer.workspaceId,
      agentId: pointer.agentId,
      environment: pointer.environment,
      number: pointer.number,
      reason,
      movedByPrincipalId,
      movedAt: pointer.updatedAt,
    });
    return {
      agentId: pointer.agentId,
      environment: pointer.environment,
      versionId: pointer.versionId,
      number: pointer.number,
      updatedAt: pointer.updatedAt,
    };
  };

  const store = (workspaceId: string): WorkspaceAgentVersionStore => {
    const agents = options.agents.forWorkspace(workspaceId);
    const agentExists = async (agentId: string): Promise<boolean> =>
      (await agents.get(agentId)) !== null;
    /**
     * Hand a materialised agent's assignments, storage grants included, to the resource store the
     * resources GET reads: in PostgreSQL both read the same tables.
     */
    const shareAssignments = async (
      agentId: string,
      written: MaterialisedAssignments,
    ): Promise<void> => {
      await options.resources?.forWorkspace(workspaceId).replace(agentId, written);
    };
    /** Core's `storage-grant-changed` audit: one row when the grants differ, none otherwise. */
    const recordGrantChange = (
      agentId: string,
      before: readonly StorageGrantRef[],
      after: readonly StorageGrantRef[],
      audit: AgentPointerAudit | undefined,
    ): void => {
      const change = storageGrantChange(before, after);
      if (audit === undefined || change === null) return;
      audits.push({
        ...audit,
        subjectLabel: `${audit.subjectLabel}: ${change}`,
        workspaceId,
        action: 'storage-grant-changed',
        subjectId: agentId,
      });
    };
    const versionsOf = (agentId: string): AgentVersionRecord[] =>
      versions.filter((row) => row.workspaceId === workspaceId && row.agentId === agentId);
    const versionById = (versionId: string): AgentVersionRecord | undefined =>
      versions.find((row) => row.workspaceId === workspaceId && row.id === versionId);
    /** The body an agent row was last written from, while the row is still as that write left it. */
    const materialisedBodyOf = (agent: { id: string; updatedAt: Date }): unknown => {
      const written = writtenFrom.get(agent.id);
      return written?.agentUpdatedAt === agent.updatedAt.getTime()
        ? versionById(written.versionId)?.body
        : undefined;
    };
    /** The other agents whose materialised body names `name` as a subagent, sorted. */
    const parentsOf = async (name: string, excludeAgentId: string | null): Promise<string[]> =>
      (await agents.list())
        .filter(
          (agent) =>
            agent.id !== excludeAgentId &&
            bodySubagentNames(materialisedBodyOf(agent)).includes(name),
        )
        .map((agent) => agent.name)
        .sort();
    /** Core's `checkSubagentNesting` for a body about to be materialised under `name`. */
    const subagentNesting = async (
      agentId: string | null,
      name: string,
      body: unknown,
    ): Promise<{ kind: 'subagent-nesting'; unusable: string[]; parents: string[] } | null> => {
      const subagents = bodySubagentNames(body);
      if (subagents.length === 0) return null;
      const found = await store(workspaceId).agentsByName(subagents);
      const unusable = subagents.filter((subagent) => {
        const candidate = found.get(subagent);
        return candidate === undefined || candidate.hasSubagents || candidate.id === agentId;
      });
      const parents = await parentsOf(name, agentId);
      return unusable.length > 0 || parents.length > 0
        ? { kind: 'subagent-nesting', unusable, parents }
        : null;
    };
    /** Pointers of this workspace and environment, in core's `findPointedSurface` order. */
    const pointedIn = (environment: AgentVersionEnvironment): SeededPointer[] =>
      pointers
        .filter((row) => row.workspaceId === workspaceId && row.environment === environment)
        .sort(
          (left, right) =>
            left.updatedAt.getTime() - right.updatedAt.getTime() ||
            left.agentId.localeCompare(right.agentId),
        );
    /** C9: the first (sorted) surface name of `body` another agent's pointed version serves. */
    const takenSurfaceName = (
      agentId: string | null,
      body: unknown,
      environment: AgentVersionEnvironment,
    ): string | null => {
      const theirs = new Set(
        pointedIn(environment)
          .filter((row) => row.agentId !== agentId)
          .flatMap((row) => surfacesOf(versionById(row.versionId)?.body).map((s) => s.name)),
      );
      const taken = surfacesOf(body)
        .map((surface) => surface.name)
        .filter((name) => theirs.has(name))
        .sort();
      return taken[0] ?? null;
    };
    const nameTaken = async (name: string, exceptId: string | null): Promise<boolean> =>
      (await agents.list()).some((row) => row.id !== exceptId && row.name === name);

    return {
      async create(agentId, input: CreateAgentVersionInput): Promise<CreateAgentVersionOutcome> {
        if (!(await agentExists(agentId))) return { kind: 'not-found' };
        if (principalIsUnknown(input.createdByPrincipalId)) return { kind: 'unknown-principal' };
        const number = Math.max(0, ...versionsOf(agentId).map((row) => row.number)) + 1;
        if (input.number !== undefined && input.number !== number) return { kind: 'number-taken' };
        const version: AgentVersionRecord = {
          id: newId(),
          workspaceId,
          agentId,
          number,
          summary: input.summary,
          via: input.via,
          body: input.body,
          createdByPrincipalId: input.createdByPrincipalId,
          createdAt: now(),
        };
        versions.push(version);
        versionGrants.set(version.id, distinctFolders(input.storageGrants ?? []));
        return { kind: 'created', version };
      },

      async list(agentId): Promise<AgentVersionListing | null> {
        const agent = await agents.get(agentId);
        if (agent === null) return null;
        const written = writtenFrom.get(agentId);
        return {
          materialisedVersionId:
            written?.agentUpdatedAt === agent.updatedAt.getTime() ? written.versionId : null,
          versions: versionsOf(agentId).sort((left, right) => left.number - right.number),
          pointers: pointers
            .filter((row) => row.workspaceId === workspaceId && row.agentId === agentId)
            .map((row) => ({
              agentId: row.agentId,
              environment: row.environment,
              versionId: row.versionId,
              number: row.number,
              updatedAt: row.updatedAt,
            })),
        };
      },

      find(agentId, number): Promise<AgentVersionRecord | null> {
        return Promise.resolve(versionsOf(agentId).find((row) => row.number === number) ?? null);
      },

      resolveDefinition(references): Promise<ResolveDefinitionOutcome> {
        return Promise.resolve(
          resolveFromRows(
            references,
            deletingSkillsApart(options.references?.[workspaceId] ?? {}),
            options.defaultRuntimeProfiles?.[workspaceId] ?? null,
          ),
        );
      },

      async agentsByName(names): Promise<ReadonlyMap<string, AgentSubagentCandidate>> {
        const wanted = new Set(names);
        const found = new Map<string, AgentSubagentCandidate>();
        for (const agent of await agents.list()) {
          if (!wanted.has(agent.name)) continue;
          found.set(agent.name, {
            id: agent.id,
            hasSubagents: bodyDeclaresSubagents(materialisedBodyOf(agent)),
            hasDescription: bodyHasDescription(materialisedBodyOf(agent)),
          });
        }
        return found;
      },

      subagentParents(name, excludeAgentId): Promise<readonly string[]> {
        return parentsOf(name, excludeAgentId);
      },

      namesOf(ids): Promise<ReferenceNames> {
        const seeded = options.references?.[workspaceId] ?? {};
        const byId = (kind: AgentDefinitionReferenceKind): ReadonlyMap<string, string> => {
          const wanted = new Set(ids[kind] ?? []);
          return new Map(
            (seeded[kind] ?? [])
              .filter((row) => wanted.has(row.id) && row.deleting !== true)
              .map((row) => [row.id, row.name]),
          );
        };
        return Promise.resolve({
          skill: byId('skill'),
          connector: byId('connector'),
          file: byId('file'),
          'model-connection': byId('model-connection'),
          'runtime-profile': byId('runtime-profile'),
        });
      },

      stdioConnectorNames(names): Promise<readonly string[]> {
        const wanted = new Set(names);
        return Promise.resolve(
          (options.references?.[workspaceId]?.connector ?? [])
            .filter((row) => row.stdio === true && wanted.has(row.name))
            .map((row) => row.name)
            .sort(),
        );
      },

      mcpConnectorIdsByName(names): Promise<ReadonlyMap<string, string>> {
        const wanted = new Set(names);
        return Promise.resolve(
          new Map(
            (options.references?.[workspaceId]?.connector ?? [])
              .filter((row) => row.tool !== true && wanted.has(row.name))
              .map((row) => [row.name, row.id]),
          ),
        );
      },

      storageGrantsOf(versionId): Promise<readonly StorageGrantRef[]> {
        const own = versions.some((row) => row.id === versionId && row.workspaceId === workspaceId);
        return Promise.resolve(own ? (versionGrants.get(versionId) ?? []) : []);
      },

      async isConnectionGranted(connectionId): Promise<boolean> {
        for (const [agentId, row] of assignments) {
          if (
            row.storageGrants.some((grant) => grant.connectionId === connectionId) &&
            (await agentExists(agentId))
          ) {
            return true;
          }
        }
        return false;
      },

      async applyAndPoint(agentId, input): Promise<ApplyAndPointOutcome> {
        const current = await agents.get(agentId);
        if (current === null) return { kind: 'not-found' };
        if (input.expectedVersion !== undefined) {
          const pointed =
            pointers.find(
              (row) =>
                row.workspaceId === workspaceId &&
                row.agentId === agentId &&
                row.environment === input.environment,
            )?.number ?? null;
          if (pointed !== input.expectedVersion) return { kind: 'pointer-moved', current: pointed };
        }
        const version = versionsOf(agentId).find((row) => row.number === input.number);
        if (version === undefined) return { kind: 'version-not-found' };
        const rewritesRow = input.environment === 'local';
        if (rewritesRow) {
          const nesting = await subagentNesting(agentId, input.agent.name, version.body);
          if (nesting !== null) return nesting;
        }
        if (rewritesRow && (await nameTaken(input.agent.name, agentId))) {
          return { kind: 'name-conflict', name: input.agent.name };
        }
        const taken = takenSurfaceName(agentId, version.body, input.environment);
        if (taken !== null) return { kind: 'surface-name-taken', name: taken };
        const pointed: SeededPointer = {
          workspaceId,
          agentId,
          environment: input.environment,
          versionId: version.id,
          number: version.number,
          updatedAt: now(),
        };
        const audit: RecordedPointerAudit = {
          ...input.audit,
          workspaceId,
          action: 'agent-changed',
          subjectId: agentId,
        };
        if (!rewritesRow) {
          const pointer = movePointer(pointed, input.reason, input.audit.actorPrincipalId);
          audits.push(audit);
          const policy = current.policy === null ? null : toStoredPolicy(current.policy);
          return { kind: 'applied', agent: { ...current, policy }, pointer };
        }

        const updated = await agents.update(agentId, {
          ...rowOf(input.agent),
          runtimeProfileId: appliedRuntimeProfileId(
            version.body,
            current.runtimeProfileId,
            input.agent.references.runtimeProfileId,
          ),
        });
        if (updated.kind !== 'updated') return agentWriteRefusal(updated);
        const withPolicy = await agents.replacePolicy(agentId, input.agent.policy);
        if (withPolicy.kind !== 'updated') {
          throw new Error(`the in-memory agent ${agentId} vanished during a materialisation`);
        }
        const written = toAssignments(input.agent);
        recordGrantChange(
          agentId,
          assignments.get(agentId)?.storageGrants ?? [],
          written.storageGrants,
          input.audit,
        );
        assignments.set(agentId, written);
        await shareAssignments(agentId, written);
        const pointer = movePointer(pointed, input.reason, input.audit.actorPrincipalId);
        writtenFrom.set(agentId, {
          versionId: version.id,
          agentUpdatedAt: withPolicy.agent.updatedAt.getTime(),
        });
        audits.push(audit);
        return {
          kind: 'applied',
          agent: { ...withPolicy.agent, policy: input.agent.policy },
          pointer,
        };
      },

      agentsCreatedSince: (since) => countCreatedSince(agents, since),

      async createAgentWithFirstVersion(input): Promise<CreateAgentWithFirstVersionOutcome> {
        const { agent: materialised, version: versionInput, environment } = input;
        if (
          principalIsUnknown(materialised.ownerPrincipalId) ||
          principalIsUnknown(versionInput.createdByPrincipalId)
        ) {
          return { kind: 'unknown-principal' };
        }
        if (
          input.quota !== undefined &&
          (await countCreatedSince(agents, input.quota.since)) >= input.quota.limit
        ) {
          return { kind: 'quota-exceeded' };
        }
        const nesting = await subagentNesting(null, materialised.name, versionInput.body);
        if (nesting !== null) return nesting;
        if (await nameTaken(materialised.name, null)) {
          return { kind: 'name-conflict', name: materialised.name };
        }
        const taken = takenSurfaceName(null, versionInput.body, environment);
        if (taken !== null) return { kind: 'surface-name-taken', name: taken };

        // Built and parsed before any write, so a refused row leaves nothing behind; the new agent's
        // id is filled in below, once the agent exists.
        const createdAudit = createdAuditRow(workspaceId, input);

        const created = await agents.create(rowOf(materialised), {
          principalId: materialised.ownerPrincipalId,
          userId: materialised.createdBy,
        });
        if (created.kind !== 'created') {
          const refusal = agentWriteRefusal(created);
          if (refusal.kind === 'not-found') {
            throw new Error('the in-memory agent store answered not-found to a create');
          }
          return refusal;
        }
        const agentId = created.agent.id;
        const withPolicy = await agents.replacePolicy(agentId, materialised.policy);
        if (withPolicy.kind !== 'updated') {
          throw new Error(`the in-memory agent ${agentId} vanished during its own create`);
        }
        const first = toAssignments(materialised);
        assignments.set(agentId, first);
        await shareAssignments(agentId, first);
        recordGrantChange(agentId, [], first.storageGrants, input.audit);
        const version: AgentVersionRecord = {
          id: newId(),
          workspaceId,
          agentId,
          number: 1,
          summary: versionInput.summary,
          via: versionInput.via,
          body: versionInput.body,
          createdByPrincipalId: versionInput.createdByPrincipalId,
          createdAt: now(),
        };
        versions.push(version);
        versionGrants.set(version.id, first.storageGrants);
        writtenFrom.set(agentId, {
          versionId: version.id,
          agentUpdatedAt: withPolicy.agent.updatedAt.getTime(),
        });
        const pointer = movePointer(
          {
            workspaceId,
            agentId,
            environment,
            versionId: version.id,
            number: version.number,
            updatedAt: now(),
          },
          'set',
          versionInput.createdByPrincipalId,
        );
        if (createdAudit !== null) {
          audits.push({
            ...createdAudit,
            subjectId: agentId,
            // Parsed again with the real id; it cannot fail, as the same details passed above.
            details: AgentCreatedAuditDetailsSchema.parse({ ...createdAudit.details, agentId }),
          });
        }
        return {
          kind: 'created',
          agent: { ...withPolicy.agent, policy: materialised.policy },
          version,
          pointer,
        };
      },

      listMoves(agentId, environment, limit): Promise<readonly AgentPointerMoveRecord[]> {
        return Promise.resolve(
          moves
            .filter(
              (row) =>
                row.workspaceId === workspaceId &&
                row.agentId === agentId &&
                (environment === null || row.environment === environment),
            )
            .reverse()
            .slice(0, limit)
            .map(({ environment: env, number, reason, movedByPrincipalId, movedAt }) => ({
              environment: env,
              number,
              reason,
              movedByPrincipalId,
              movedAt,
            })),
        );
      },

      findPointedSurface(environment, name): Promise<PointedSurface | null> {
        for (const pointer of pointedIn(environment)) {
          const version = versionById(pointer.versionId);
          const surface = surfacesOf(version?.body).find((candidate) => candidate.name === name);
          if (version !== undefined && surface !== undefined) {
            return Promise.resolve({
              agentId: pointer.agentId,
              versionId: version.id,
              number: version.number,
              surface: surface.element,
            });
          }
        }
        return Promise.resolve(null);
      },

      latestEvaluation(versionId): Promise<LatestEvaluation | null> {
        const owned = versions.some(
          (row) => row.workspaceId === workspaceId && row.id === versionId,
        );
        return Promise.resolve(owned ? (evaluations.get(versionId) ?? null) : null);
      },
    };
  };

  return {
    forWorkspace: (workspaceId) => Promise.resolve(store(workspaceId)),
    versionCount: () => versions.length,
    pointerCount: () => pointers.length,
    audits: () => [...audits],
    point: (pointer) => {
      movePointer(pointer, 'set', null);
    },
    assignmentsOf: (agentId) => assignments.get(agentId),
    recordEvaluation: (versionId, evaluation) => {
      evaluations.set(versionId, evaluation);
    },
  };
}
