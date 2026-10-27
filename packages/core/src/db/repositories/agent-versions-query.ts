/** The reference-resolution and subagent lookups of the agent version store; see `./agent-versions.ts`. */
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { agentStorageGrants } from '../schema/agent-storage-grants.js';
import { agentVersionStorageGrants } from '../schema/agent-version-storage-grants.js';
import { agentVersions } from '../schema/agent-versions.js';
import { agents } from '../schema/agents.js';
import { files } from '../schema/files.js';
import { mcpServers } from '../schema/mcp-servers.js';
import { modelConnections } from '../schema/model-connections.js';
import { runtimeProfiles } from '../schema/runtime-profiles.js';
import { skills } from '../schema/skills.js';
import { checkSkillRevisionPins } from './agent-skill-revision-pins.js';
import type {
  AgentSubagentCandidate,
  AgentVersionRepository,
  ReferenceNames,
} from './agent-versions.js';
import {
  resolveFromRows,
  type AgentDefinitionReferenceKind,
  type NamedRow,
  type ResolveDefinitionOutcome,
  type StorageGrantRef,
} from './agent-versions-resolution.js';
import {
  bodyDeclaresSubagents,
  bodyHasDescription,
  ConflictRow,
  type Executor,
} from './agent-versions-shared.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The two subagent lookups, shared with the write module's nesting check. */
export function subagentLookups(workspaceId: string): {
  readonly candidatesByName: (
    executor: Executor,
    names: readonly string[],
  ) => Promise<ReadonlyMap<string, AgentSubagentCandidate>>;
  readonly parentsOf: (
    executor: Executor,
    name: string,
    excludeAgentId: string | null,
  ) => Promise<readonly string[]>;
} {
  /** The agents named `names`, with whether their materialised version declares subagents and a description. */
  const candidatesByName = async (
    executor: Executor,
    names: readonly string[],
  ): Promise<ReadonlyMap<string, AgentSubagentCandidate>> => {
    if (names.length === 0) return new Map();
    const rows = await executor
      .select({ id: agents.id, name: agents.name, body: agentVersions.body })
      .from(agents)
      .leftJoin(
        agentVersions,
        and(
          eq(agentVersions.workspaceId, agents.workspaceId),
          eq(agentVersions.id, agents.materialisedVersionId),
        ),
      )
      .where(and(eq(agents.workspaceId, workspaceId), inArray(agents.name, [...new Set(names)])));
    return new Map(
      rows.map((row) => [
        row.name,
        {
          id: row.id,
          hasSubagents: bodyDeclaresSubagents(row.body),
          hasDescription: bodyHasDescription(row.body),
        },
      ]),
    );
  };

  /** The other agents whose materialised version names `name` as a subagent, sorted. */
  const parentsOf = async (
    executor: Executor,
    name: string,
    excludeAgentId: string | null,
  ): Promise<readonly string[]> => {
    const result = await executor.execute(sql`
      select distinct a.name
      from agents a
      join agent_versions v
        on v.workspace_id = a.workspace_id
       and v.id = a.materialised_version_id
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(v.body->'subagents') = 'array' then v.body->'subagents' else '[]'::jsonb end
      ) as s(elem)
      where a.workspace_id = ${workspaceId}
        and (${excludeAgentId}::uuid is null or a.id <> ${excludeAgentId}::uuid)
        and s.elem->>'name' = ${name}`);
    return result.rows.map((row) => ConflictRow.parse(row).name).sort();
  };

  return { candidatesByName, parentsOf };
}

export function agentVersionQueries(
  db: Database,
  workspaceId: string,
): Pick<
  AgentVersionRepository,
  | 'resolveDefinition'
  | 'namesOf'
  | 'stdioConnectorNames'
  | 'isConnectionGranted'
  | 'storageGrantsOf'
  | 'mcpConnectorIdsByName'
  | 'agentsByName'
  | 'subagentParents'
> {
  const { candidatesByName, parentsOf } = subagentLookups(workspaceId);

  /**
   * This workspace's rows of `kind` whose name (a file's path) — or, `by: 'id'`, whose id — is
   * one of `values`. An id that is not a UUID cannot match a `uuid` column and is never sent.
   */
  const referenceRows = async (
    kind: AgentDefinitionReferenceKind,
    by: 'id' | 'name',
    values: readonly string[],
  ): Promise<readonly NamedRow[]> => {
    const wanted = [...new Set(values)].filter(
      (value) => by === 'name' || UUID_PATTERN.test(value),
    );
    if (wanted.length === 0) return [];
    switch (kind) {
      case 'skill':
        return db
          .select({ id: skills.id, name: skills.name })
          .from(skills)
          .where(
            and(
              eq(skills.workspaceId, workspaceId),
              // A skill being deleted resolves like a missing one.
              isNull(skills.pendingDelete),
              inArray(by === 'id' ? skills.id : skills.name, wanted),
            ),
          );
      case 'connector':
        return db
          .select({ id: mcpServers.id, name: mcpServers.name })
          .from(mcpServers)
          .where(
            and(
              // Every kind: a tool connector is referenced by its name (ADR-0113 C15) and
              // compose hands it to the engine through the gateway (S2-02f, #531).
              eq(mcpServers.workspaceId, workspaceId),
              inArray(by === 'id' ? mcpServers.id : mcpServers.name, wanted),
            ),
          );
      case 'file':
        return db
          .select({ id: files.id, name: files.path })
          .from(files)
          .where(
            and(
              eq(files.workspaceId, workspaceId),
              // A pending upload is not a file yet (the storage design, §04).
              eq(files.status, 'ready'),
              inArray(by === 'id' ? files.id : files.path, wanted),
            ),
          );
      case 'model-connection':
        return db
          .select({ id: modelConnections.id, name: modelConnections.name })
          .from(modelConnections)
          .where(
            and(
              eq(modelConnections.workspaceId, workspaceId),
              inArray(by === 'id' ? modelConnections.id : modelConnections.name, wanted),
            ),
          );
      case 'runtime-profile':
        return db
          .select({ id: runtimeProfiles.id, name: runtimeProfiles.name })
          .from(runtimeProfiles)
          .where(
            and(
              eq(runtimeProfiles.workspaceId, workspaceId),
              inArray(by === 'id' ? runtimeProfiles.id : runtimeProfiles.name, wanted),
            ),
          );
    }
  };
  /** This workspace's default runtime profile id (issue #504), or `null` when it has none. */
  const workspaceDefaultRuntimeProfileId = async (): Promise<string | null> => {
    const rows = await db
      .select({ id: runtimeProfiles.id })
      .from(runtimeProfiles)
      .where(
        and(
          eq(runtimeProfiles.workspaceId, workspaceId),
          eq(runtimeProfiles.workspaceDefault, true),
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  };

  /** The skills of `names` whose delete is under way: they do not resolve (409, not 400). */
  const deletingSkills = async (names: readonly string[]): Promise<readonly NamedRow[]> => {
    const wanted = [...new Set(names)];
    if (wanted.length === 0) return [];
    return db
      .select({ id: skills.id, name: skills.name })
      .from(skills)
      .where(
        and(
          eq(skills.workspaceId, workspaceId),
          isNotNull(skills.pendingDelete),
          inArray(skills.name, wanted),
        ),
      );
  };

  return {
    async resolveDefinition(references): Promise<ResolveDefinitionOutcome> {
      const modelConnectionName = references.modelConnectionName ?? 'default';
      const [
        skillRows,
        deletingSkillRows,
        connectorRows,
        fileRows,
        connectionRows,
        profileRows,
        defaultProfileId,
      ] = await Promise.all([
        referenceRows('skill', 'name', references.skills),
        deletingSkills(references.skills),
        referenceRows('connector', 'name', references.connectors),
        referenceRows(
          'file',
          'name',
          references.files.map((grant) => grant.path),
        ),
        referenceRows('model-connection', 'name', [modelConnectionName]),
        referenceRows(
          'runtime-profile',
          'name',
          references.runtimeProfileName === null ? [] : [references.runtimeProfileName],
        ),
        references.runtimeProfileName === null
          ? workspaceDefaultRuntimeProfileId()
          : Promise.resolve(null),
      ]);
      return checkSkillRevisionPins(
        db,
        workspaceId,
        references,
        resolveFromRows(
          references,
          {
            skill: skillRows,
            deletingSkill: deletingSkillRows,
            connector: connectorRows,
            file: fileRows,
            'model-connection': connectionRows,
            'runtime-profile': profileRows,
          },
          defaultProfileId,
        ),
      );
    },

    async namesOf(ids): Promise<ReferenceNames> {
      const byId = async (kind: AgentDefinitionReferenceKind) =>
        new Map(
          (await referenceRows(kind, 'id', ids[kind] ?? [])).map((row) => [row.id, row.name]),
        );
      const [skill, connector, file, modelConnection, runtimeProfile] = await Promise.all([
        byId('skill'),
        byId('connector'),
        byId('file'),
        byId('model-connection'),
        byId('runtime-profile'),
      ]);
      return {
        skill,
        connector,
        file,
        'model-connection': modelConnection,
        'runtime-profile': runtimeProfile,
      };
    },

    async isConnectionGranted(connectionId): Promise<boolean> {
      const rows = await db
        .select({ id: agentStorageGrants.id })
        .from(agentStorageGrants)
        .where(
          and(
            eq(agentStorageGrants.workspaceId, workspaceId),
            eq(agentStorageGrants.connectionId, connectionId),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async storageGrantsOf(versionId): Promise<readonly StorageGrantRef[]> {
      if (!UUID_PATTERN.test(versionId)) return [];
      return db
        .select({
          connectionId: agentVersionStorageGrants.connectionId,
          prefix: agentVersionStorageGrants.prefix,
          access: agentVersionStorageGrants.access,
        })
        .from(agentVersionStorageGrants)
        .where(
          and(
            eq(agentVersionStorageGrants.workspaceId, workspaceId),
            eq(agentVersionStorageGrants.versionId, versionId),
          ),
        )
        .orderBy(
          asc(agentVersionStorageGrants.connectionId),
          asc(agentVersionStorageGrants.prefix),
        );
    },

    async stdioConnectorNames(names): Promise<readonly string[]> {
      if (names.length === 0) return [];
      const rows = await db
        .select({ name: mcpServers.name })
        .from(mcpServers)
        .where(
          and(
            eq(mcpServers.workspaceId, workspaceId),
            eq(mcpServers.kind, 'mcp'),
            eq(mcpServers.transport, 'stdio'),
            inArray(mcpServers.name, [...new Set(names)]),
          ),
        )
        .orderBy(asc(mcpServers.name));
      return rows.map((row) => row.name);
    },

    async mcpConnectorIdsByName(names): Promise<ReadonlyMap<string, string>> {
      if (names.length === 0) return new Map();
      const rows = await db
        .select({ id: mcpServers.id, name: mcpServers.name })
        .from(mcpServers)
        .where(
          and(
            eq(mcpServers.workspaceId, workspaceId),
            eq(mcpServers.kind, 'mcp'),
            inArray(mcpServers.name, [...new Set(names)]),
          ),
        );
      // `mcp_servers_workspace_name_key`: a name is one connector's.
      return new Map(rows.map((row) => [row.name, row.id]));
    },

    agentsByName(names): Promise<ReadonlyMap<string, AgentSubagentCandidate>> {
      return candidatesByName(db, names);
    },

    subagentParents(name, excludeAgentId): Promise<readonly string[]> {
      return parentsOf(db, name, excludeAgentId);
    },
  };
}
