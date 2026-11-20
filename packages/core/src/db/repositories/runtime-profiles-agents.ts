import { sql } from 'drizzle-orm';

import type { Database } from '../client.js';

/** What a database transaction offers that the attach below needs. */
type Executor = Pick<Database, 'execute'>;

/**
 * Attach `profileId`, the workspace's default, to every agent of `workspaceId` the default should
 * already be on (issue #504, S1-22 review): the agent row has no runtime profile, every version
 * pointed at it names none (`definition.agent.runtimeProfileName` is JSON `null`), and the row was
 * not edited after a pointer moved (`agents.materialised_version_id = agent_version_pointers.version_id`).
 * Applying that version again now would write exactly this, so it is the same materialisation, not
 * a new choice.
 *
 * `materialised_version_id` and `updated_at` are deliberately left alone: the row still equals its
 * pointed version. An agent that was never pointed, was edited by hand after its pointer moved, or
 * whose version names a profile is not touched.
 */
export async function attachDefaultToUnprofiledAgents(
  tx: Executor,
  workspaceId: string,
  profileId: string,
  /** The default being replaced: its agents move instead of the ones with no profile. */
  replacedDefaultId: string | null = null,
): Promise<void> {
  const carried =
    replacedDefaultId === null
      ? sql`a.runtime_profile_id is null`
      : sql`a.runtime_profile_id = ${replacedDefaultId}`;
  await tx.execute(sql`
    update agents a
       set runtime_profile_id = ${profileId}
     where a.workspace_id = ${workspaceId}
       and ${carried}
       and exists (
         select 1
           from agent_version_pointers p
           join agent_versions v on v.id = p.version_id and v.workspace_id = p.workspace_id
          where p.workspace_id = ${workspaceId}
            and p.agent_id = a.id
            and jsonb_typeof(v.body #> array['definition', 'agent', 'runtimeProfileName']) = 'null'
            and a.materialised_version_id = p.version_id
       )
       and not exists (
         select 1
           from agent_version_pointers p
           join agent_versions v on v.id = p.version_id and v.workspace_id = p.workspace_id
          where p.workspace_id = ${workspaceId}
            and p.agent_id = a.id
            and jsonb_typeof(v.body #> array['definition', 'agent', 'runtimeProfileName'])
                is distinct from 'null'
       )
  `);
}
