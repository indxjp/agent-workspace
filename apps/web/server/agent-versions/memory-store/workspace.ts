import type { MaterialisedAssignments, SeededPointer } from './model';
import { surfacesOf } from './rows';
import type { MemoryVersionState } from './state';
import {
  bodyDeclaresSubagents,
  bodyHasDescription,
  bodySubagentNames,
  storageGrantChange,
  type AgentPointerAudit,
  type AgentSubagentCandidate,
  type AgentVersionEnvironment,
  type AgentVersionRecord,
  type StorageGrantRef,
} from '../store';

export function createMemoryVersionWorkspace(state: MemoryVersionState, workspaceId: string) {
  const { versions, pointers, audits, writtenFrom, options } = state;
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
    const found = await agentsByName(subagents);
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
  async function agentsByName(
    names: readonly string[],
  ): Promise<ReadonlyMap<string, AgentSubagentCandidate>> {
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
  }
  return {
    ...state,
    workspaceId,
    agents,
    agentExists,
    shareAssignments,
    recordGrantChange,
    versionsOf,
    versionById,
    materialisedBodyOf,
    parentsOf,
    subagentNesting,
    pointedIn,
    takenSurfaceName,
    nameTaken,
    agentsByName,
  };
}
export type MemoryVersionWorkspace = ReturnType<typeof createMemoryVersionWorkspace>;
