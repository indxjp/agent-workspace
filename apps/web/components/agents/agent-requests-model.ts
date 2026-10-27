import type { EngineDescriptor } from '@indx-workspace/contracts/engines';
import {
  ApiProblemError,
  ContractViolationError,
  type AgentWorkspaceClient,
} from '@indx-workspace/sdk';

import type {
  AgentResource,
  AgentResourceAssignments,
  AgentResourceAssignmentsInput,
  CreateAgentInput,
} from '../../contracts/agents';
import type { ProjectResource } from '../../contracts/projects';
import { requestOutcome, type RequestOutcome } from '../../lib/request-outcome';
import { toFileRows } from '../resources/resource-screens';
import {
  fetchFileCatalog,
  readAgentResourceOptions,
  readNamedCatalog,
  readRuntimeProfileOptions,
  type AgentResourceOptions,
  type FileCatalog,
  type NamedCatalog,
  type RuntimeProfileOption,
} from './model';

/**
 * The agent screens' calls through the SDK client. Each resolves with what the screen shows: a
 * value, or the `RequestProblem` the screen renders for a refused or unanswered request.
 */

const outcome = <T>(request: Promise<T>, failed: string) =>
  requestOutcome(request, failed, `${failed}: the answer did not match the contract.`);

const BEFORE_ANSWER = 'The request failed before the server could answer';

/** `GET /api/agents`. */
export function loadAgents(
  client: AgentWorkspaceClient,
): Promise<RequestOutcome<readonly AgentResource[]>> {
  return outcome(client.agents.list(), 'The request to load agents failed');
}

/** `GET /api/engines`: the engines this deployment offers, or why not. */
export function loadEngines(
  client: AgentWorkspaceClient,
): Promise<RequestOutcome<readonly EngineDescriptor[]>> {
  // A body the published contract refuses is drift, reported as itself, not as a transport failure.
  return requestOutcome(
    client.engines.list(),
    BEFORE_ANSWER,
    'The engines response was not the published catalogue.',
  );
}

export interface LoadedAgent {
  readonly agent: AgentResource;
  readonly assignments: AgentResourceAssignments;
}

/** `GET /api/agents/:id` and `/resources`, together. */
export function loadAgent(
  client: AgentWorkspaceClient,
  agentId: string,
): Promise<RequestOutcome<LoadedAgent>> {
  return outcome(
    Promise.all([client.agents.get(agentId), client.agents.getResourceAssignments(agentId)]).then(
      ([agent, assignments]) => ({ agent, assignments }),
    ),
    BEFORE_ANSWER,
  );
}

/** `PATCH /api/agents/:id` with every field the detail screen edits; the agent as stored. */
export function saveAgentDefinition(
  client: AgentWorkspaceClient,
  agent: AgentResource,
): Promise<RequestOutcome<AgentResource>> {
  return outcome(
    client.agents.update(agent.id, {
      name: agent.name,
      instructions: agent.instructions,
      modelConnectionId: agent.modelConnectionId,
      model: agent.model,
      runtimeProfileId: agent.runtimeProfileId,
      permissions: agent.permissions,
    }),
    BEFORE_ANSWER,
  );
}

/** `PUT /api/agents/:id/resources`; the assignments the server actually stored. */
export function saveAgentAssignments(
  client: AgentWorkspaceClient,
  agentId: string,
  assignments: AgentResourceAssignmentsInput,
): Promise<RequestOutcome<AgentResourceAssignments>> {
  return outcome(client.agents.replaceResourceAssignments(agentId, assignments), BEFORE_ANSWER);
}

/** `POST /api/agents` with its resource assignments in one request; the new agent's id. */
export function createAgent(
  client: AgentWorkspaceClient,
  agent: CreateAgentInput,
  assignments: AgentResourceAssignmentsInput,
): Promise<RequestOutcome<string>> {
  return outcome(
    client.agents.create(agent, { assignments }).then((created) => created.agent.id),
    'The request to create this agent failed',
  );
}

function optional<T>(read: Promise<readonly T[]>): Promise<readonly T[]> {
  return read.catch((error: unknown) => {
    if (error instanceof ApiProblemError) return [];
    throw error;
  });
}

/**
 * The new-agent form's four reads. Files, skills and connectors are optional subsystems (a `503`
 * when unconfigured): a refused read contributes an empty group. Runtime profiles are required, so
 * their refusal rejects, naming the status.
 */
export async function loadNewAgentCatalogs(client: AgentWorkspaceClient): Promise<{
  readonly runtimeProfiles: readonly RuntimeProfileOption[];
  readonly resources: AgentResourceOptions;
}> {
  const profiles = client.runtimes.profiles.list().catch((error: unknown) => {
    if (error instanceof ApiProblemError) {
      throw new Error(`Runtime profiles request returned ${String(error.status)}.`, {
        cause: error,
      });
    }
    throw error;
  });
  const [runtimeProfiles, files, skills, connectors] = await Promise.all([
    profiles,
    optional(client.files.list()),
    optional(client.skills.list()),
    optional(client.connectors.list()),
  ]);
  return {
    runtimeProfiles: readRuntimeProfileOptions({ runtimeProfiles }),
    resources: readAgentResourceOptions({ files }, { skills }, { connectors }),
  };
}

/**
 * The id to name catalogs the assignment editor renders by name. The file tree is walked one level
 * per `GET /api/files?path=`; a refused level, skills read or connectors read is empty. A transport
 * failure rejects, because a catalog that silently came back empty would mislabel every existing
 * grant as missing.
 */
export async function loadResourceCatalogs(client: AgentWorkspaceClient): Promise<{
  readonly files: FileCatalog;
  readonly skills: NamedCatalog;
  readonly connectors: NamedCatalog;
}> {
  const files = await fetchFileCatalog(async (path) =>
    toFileRows({ files: await optional(client.files.list({ path })) }),
  );
  const [skills, connectors] = await Promise.all([
    optional(client.skills.list()),
    optional(client.connectors.list()),
  ]);
  return {
    files,
    skills: readNamedCatalog({ skills }, 'skills'),
    connectors: readNamedCatalog({ connectors }, 'connectors'),
  };
}

/** `GET /api/projects` for the read-only "project-provided" group; rejects with one line of why. */
export async function loadAgentProjects(
  client: AgentWorkspaceClient,
): Promise<readonly ProjectResource[]> {
  try {
    return await client.projects.list();
  } catch (error) {
    if (error instanceof ApiProblemError) {
      throw new Error(`GET /api/projects returned ${String(error.status)}.`, { cause: error });
    }
    if (error instanceof ContractViolationError) {
      throw new Error('The projects response did not match its schema.', { cause: error });
    }
    throw error;
  }
}
