import { ApiProblemError, type AgentWorkspaceClient } from '@indx-workspace/sdk';

import { requestOutcome, type RequestOutcome } from '../../lib/request-outcome';
import {
  ARCHIVE_IMPACT_RUN_LIMIT,
  archiveImpactFromReads,
  buildCreateProjectInput,
  buildProjectPatch,
  describeLifecycleFailure,
  isProjectArchived,
  readAgentOptions,
  readConnectorOptions,
  readFileOptions,
  readRunPage,
  readSessionProjectIds,
  type ArchiveImpactCounts,
  type CatalogOption,
  type ProjectDraft,
  type ProjectFilter,
  type ProjectResource,
  type RequestProblem,
} from './model';

/**
 * The project screens' calls through the SDK client. Each resolves with what the screen shows: a
 * value, or the {@link RequestProblem} the screen renders for a refused or unanswered request.
 */

const INVALID_PROJECT = 'The server returned an invalid project.';

const outcome = <T>(request: Promise<T>, failed: string) =>
  requestOutcome(request, failed, INVALID_PROJECT);

/**
 * `GET /api/projects?archived=…` for one filter, always explicit rather than relying on the route
 * default. Rejects with the server's message, or `Request returned N` when it sent none.
 */
export async function loadProjects(
  client: AgentWorkspaceClient,
  filter: ProjectFilter,
): Promise<readonly ProjectResource[]> {
  try {
    return await client.projects.list({ archived: filter });
  } catch (error) {
    if (!(error instanceof ApiProblemError)) throw error;
    throw new Error(
      error.code === 'unrecognised_error_body' || error.message.trim() === ''
        ? `Request returned ${String(error.status)}`
        : error.message,
      { cause: error },
    );
  }
}

/** `GET /api/projects/:id`. */
export function loadProject(
  client: AgentWorkspaceClient,
  id: string,
): Promise<RequestOutcome<ProjectResource>> {
  return outcome(client.projects.get(id), 'The project could not be loaded');
}

/** `POST /api/projects`: `null` once created. */
export async function createProject(
  client: AgentWorkspaceClient,
  draft: ProjectDraft,
): Promise<RequestProblem | null> {
  const created = await outcome(
    client.projects.create(buildCreateProjectInput(draft)),
    'The request to create this project failed',
  );
  return created.ok ? null : created.problem;
}

/** `PATCH /api/projects/:id` with every editable field; the project the server stored. */
export function saveProject(
  client: AgentWorkspaceClient,
  id: string,
  draft: ProjectDraft,
): Promise<RequestOutcome<ProjectResource>> {
  return outcome(
    client.projects.update(id, buildProjectPatch(draft)),
    'The request to save this project failed',
  );
}

/** `POST /api/projects/:id/archive`, or `/restore` for an archived project. */
export async function transitionProject(
  client: AgentWorkspaceClient,
  project: ProjectResource,
): Promise<RequestOutcome<ProjectResource>> {
  const action = isProjectArchived(project) ? 'restore' : 'archive';
  const result = await outcome(
    action === 'restore'
      ? client.projects.restore(project.id)
      : client.projects.archive(project.id),
    `The request to ${action} this project failed`,
  );
  return result.ok ? result : { ok: false, problem: describeLifecycleFailure(result.problem) };
}

/**
 * Count what archiving this project makes read-only, from the two list endpoints the caller already
 * has read access to. `null` when either read failed — `archiveImpactFromReads` says why a half
 * answer is not reported as a zero.
 *
 * Both counts are "what this caller can see": `GET /api/sessions` and `GET /api/runs` narrow to the
 * caller's own rows for every role below Owner/Admin, and neither publishes a total. That is why
 * the sentence `summariseArchiveImpact` builds says so out loud.
 */
export async function countArchiveImpact(
  client: AgentWorkspaceClient,
  id: string,
): Promise<ArchiveImpactCounts | null> {
  const [sessions, runs] = await Promise.all([
    client.sessions
      .list()
      .then((page) => readSessionProjectIds(page).filter((one) => one === id))
      .catch(() => null),
    client.runs
      .list({ project: id, limit: ARCHIVE_IMPACT_RUN_LIMIT })
      .then(readRunPage)
      .catch(() => null),
  ]);
  return archiveImpactFromReads(sessions, runs);
}

/**
 * `GET /api/agents`, `/api/files` and `/api/connectors` for the pickers. Files and connectors are
 * optional subsystems: a refused read (a `503` when one is not configured) contributes no options.
 * Agents are required, so their refusal rejects, naming the status.
 */
export async function loadProjectCatalogs(client: AgentWorkspaceClient): Promise<{
  readonly agents: readonly CatalogOption[];
  readonly files: readonly CatalogOption[];
  readonly connectors: readonly CatalogOption[];
}> {
  const optional = <T>(read: Promise<readonly T[]>): Promise<readonly T[]> =>
    read.catch((error: unknown) => {
      if (error instanceof ApiProblemError) return [];
      throw error;
    });
  const agents = client.agents.list().catch((error: unknown) => {
    if (error instanceof ApiProblemError) {
      throw new Error(`Agents request returned ${String(error.status)}.`, { cause: error });
    }
    throw error;
  });
  const [agentRows, files, connectors] = await Promise.all([
    agents,
    optional(client.files.list()),
    optional(client.connectors.list()),
  ]);
  return {
    agents: readAgentOptions({ agents: agentRows }),
    files: readFileOptions({ files }),
    connectors: readConnectorOptions({ connectors }),
  };
}

/** `GET /api/agents` for the list rows' default-agent names; no options when it fails. */
export function loadAgentOptions(client: AgentWorkspaceClient): Promise<readonly CatalogOption[]> {
  return client.agents.list().then(
    (agents) => readAgentOptions({ agents }),
    () => [],
  );
}
