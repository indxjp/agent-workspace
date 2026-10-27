import type { AgentWorkspaceClient } from '@indx-workspace/sdk';

type Assignments = Awaited<ReturnType<AgentWorkspaceClient['agents']['getResourceAssignments']>>;
type Listing = Awaited<ReturnType<AgentWorkspaceClient['agents']['versions']['list']>>;
export type VersionBody = Listing['items'][number]['body'];
export type GrantAccess = 'read' | 'read-write';

const STORAGE_GRANT_SUMMARY = 'Console edit: storage grant';
const STORAGE_REVOKE_SUMMARY = 'Console edit: storage grant removed';

/** `storage://<connection>/<folder>`; the folder has no leading or trailing slash. */
export function storageGrantPath(connectionName: string, folder: string): string {
  return `storage://${connectionName}/${folder.replace(/^\/+|\/+$/gu, '')}`;
}

/** The version body with `path` granted at `access`; an equal path is replaced, not repeated. */
export function withStorageGrant(
  body: VersionBody,
  path: string,
  access: GrantAccess,
): VersionBody {
  const { files } = body.definition.resources;
  const grant = { path, access };
  const granted = files.some((file) => file.path === path);
  return {
    ...body,
    definition: {
      ...body.definition,
      resources: {
        ...body.definition.resources,
        files: granted
          ? files.map((file) => (file.path === path ? grant : file))
          : [...files, grant],
      },
    },
  };
}

/** The version body without the grant at `path`. */
export function withoutStorageGrant(body: VersionBody, path: string): VersionBody {
  return {
    ...body,
    definition: {
      ...body.definition,
      resources: {
        ...body.definition.resources,
        files: body.definition.resources.files.filter((file) => file.path !== path),
      },
    },
  };
}

/** The `local` body, unless the agent row was edited since: building on it would revert that edit. */
function localBody(listing: Listing): VersionBody | undefined {
  const local = listing.pointers.find((pointer) => pointer.environment === 'local');
  if (local === undefined || listing.materialised !== local.number) return undefined;
  return listing.items.find((version) => version.number === local.number)?.body;
}

/**
 * Saves the agent's storage grants as a console-edit version and moves `local` onto it, because
 * `PUT /resources` ignores storage grants. An agent with no `local` version yet, or one edited
 * outside versions since, gets one first by re-saving its stored assignments (a console edit built
 * from the agent row).
 */
async function saveStorageGrants(
  client: AgentWorkspaceClient,
  agentId: string,
  summary: string,
  change: (body: VersionBody) => VersionBody,
): Promise<Assignments> {
  const { agents } = client;
  let base = localBody(await agents.versions.list(agentId));
  if (base === undefined) {
    await agents.replaceResourceAssignments(agentId, await agents.getResourceAssignments(agentId));
    base = localBody(await agents.versions.list(agentId));
  }
  if (base === undefined) throw new Error('The agent has no version to change the grant in.');
  const created = await agents.versions.create(agentId, {
    body: change(base),
    summary,
    via: 'ui',
  });
  await agents.pointers.set(agentId, { environment: 'local', version: created.number });
  return agents.getResourceAssignments(agentId);
}

/** Grants one folder to an agent. */
export function saveStorageGrant(
  client: AgentWorkspaceClient,
  agentId: string,
  path: string,
  access: GrantAccess,
): Promise<Assignments> {
  return saveStorageGrants(client, agentId, STORAGE_GRANT_SUMMARY, (body) =>
    withStorageGrant(body, path, access),
  );
}

/** Removes the grant at `path` from an agent; a grant missing from the `local` body is refused. */
export function removeStorageGrant(
  client: AgentWorkspaceClient,
  agentId: string,
  path: string,
): Promise<Assignments> {
  return saveStorageGrants(client, agentId, STORAGE_REVOKE_SUMMARY, (body) => {
    if (!body.definition.resources.files.some((file) => file.path === path)) {
      throw new Error("The grant is not in the agent's current version.");
    }
    return withoutStorageGrant(body, path);
  });
}
