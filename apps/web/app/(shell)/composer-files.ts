/**
 * RF-502 (#2089): the home chat's "+ Files" picker lists the workspace files and folders the
 * chosen agent is granted, so a person can narrow a chat to some of them.
 *
 * A picked option's id is the grant's workspace path. The composer sends the picks as the run's
 * `fileScope` (ADR-0147), which the run start re-checks against the agent's effective grants and
 * refuses with `403 run_file_scope_not_granted` if a path is outside them. So the list below is
 * only what to offer: nothing a browser sends can widen what a run may read.
 *
 * Storage-connection folders (`storageGrants`) are not listed: `fileScope` narrows workspace
 * files only, so offering them would promise a narrowing the run does not apply.
 */
import { MAX_RUN_FILE_SCOPE_PATHS } from '@indx-workspace/contracts/runs';
import type { AgentResourceAssignments } from '@indx-workspace/contracts/agents';

import type { PickerOption } from '../../components/composer/model';
import type { ComposerStrings } from '../../components/composer/composer-messages';
import { applicationContext } from '../../server/application-context';
import { agentResourcesOwnership } from '../../server/agents/resource-ownership';
import type { AgentRecord } from '../../server/agents/contract';
import { requireResourceAccess } from '../../server/resources/authorise';
import { workspaceCatalogFiles } from '../../server/files/catalog-listing';
import { log } from '../../server/telemetry/logger';

/** The fields of a catalog row the picker reads. */
export interface ComposerCatalogRow {
  readonly id: string;
  readonly path: string;
  readonly kind: 'file' | 'folder';
  readonly area?: string;
}

/**
 * The picker options for one agent: each file grant whose row is in the catalog, by path, at most
 * {@link MAX_RUN_FILE_SCOPE_PATHS} (the most a run's `fileScope` may name). An agent without
 * `readFiles` gets none: its run reads no files, so any pick would be refused. Skill files are
 * rows of the same catalog that no grant reaches, as in the run's own loader.
 */
export function composerFileOptions(
  agent: { readonly permissions: { readonly readFiles: boolean } },
  assignments: Pick<AgentResourceAssignments, 'files'> | null,
  rowsById: ReadonlyMap<string, ComposerCatalogRow>,
  strings: Pick<ComposerStrings, 'fileOptionDetail'>,
): PickerOption[] {
  if (!agent.permissions.readFiles || assignments === null) return [];
  const options = new Map<string, PickerOption>();
  for (const grant of assignments.files) {
    const row = rowsById.get(grant.fileId);
    if (row === undefined || row.area === 'skills') continue;
    const folder = row.kind === 'folder';
    const name = row.path.slice(row.path.lastIndexOf('/') + 1);
    options.set(row.path, {
      id: row.path,
      name: folder ? `${name}/` : name,
      detail: strings.fileOptionDetail(row.path, grant.access),
    });
  }
  return [...options.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, MAX_RUN_FILE_SCOPE_PATHS);
}

/**
 * Whether the signed-in caller may read this agent's resource assignments: the very decision
 * `GET /api/agents/:id/resources` makes, asked with this render's session cookie.
 */
async function mayReadAgentResources(
  cookie: string,
  workspaceId: string,
  agentId: string,
): Promise<boolean> {
  const request = new Request(
    `http://localhost/api/agents/${encodeURIComponent(agentId)}/resources`,
    {
      headers: { cookie },
    },
  );
  const access = await requireResourceAccess(request, agentResourcesOwnership(agentId, 'read'));
  // The same workspace this page resolved: a cookie that now identifies another one lists nothing.
  return access.ok && access.principal.workspaceId === workspaceId;
}

/**
 * Each agent's picker options, by agent id. Any agent this cannot answer for (no resource store,
 * no catalog, a refused read, a failed lookup) gets none, and the picker then says so; the run
 * still receives every grant, as before RF-502.
 */
export async function composerFilesByAgent(
  cookie: string,
  workspaceId: string,
  agents: readonly AgentRecord[],
  strings: Pick<ComposerStrings, 'fileOptionDetail'>,
): Promise<ReadonlyMap<string, readonly PickerOption[]>> {
  const out = new Map<string, readonly PickerOption[]>();
  const application = applicationContext();
  const resources = application?.agents.agentResources;
  const files = application?.files;
  if (resources === undefined || files?.kind !== 'serving') return out;
  const readers = agents.filter((agent) => agent.permissions.readFiles);
  if (readers.length === 0) return out;
  try {
    const rows = await workspaceCatalogFiles(files.runtime, workspaceId);
    if (rows === null) return out;
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const store = resources.forWorkspace(workspaceId);
    for (const agent of readers) {
      if (!(await mayReadAgentResources(cookie, workspaceId, agent.id))) continue;
      out.set(agent.id, composerFileOptions(agent, await store.get(agent.id), rowsById, strings));
    }
  } catch (error) {
    log.error('[home] the agents’ files could not be listed for the + Files picker', { error });
    return new Map();
  }
  return out;
}
