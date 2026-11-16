import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from '../../client.js';
import { agents } from '../../schema/agents.js';
import { apiKeys } from '../../schema/api-keys.js';
import { files } from '../../schema/files.js';
import { mcpServers } from '../../schema/mcp-servers.js';
import { projects } from '../../schema/projects.js';
import { sessions } from '../../schema/sessions.js';
import { shares } from '../../schema/shares.js';
import { skills } from '../../schema/skills.js';
import { workspacePrincipals } from '../../schema/workspace-principals.js';
import type { DatabaseWorkspaceDirectory } from '../directory.js';
import {
  isActiveMembershipPrincipal,
  LOCAL_RUNTIME_API_KEY_NAME_PREFIX,
  lockWorkspace,
  type Transaction,
} from './queries.js';

interface LocalKeyPrincipal {
  readonly id: string;
  readonly actsForPrincipalId: string | null;
}

/** The tables whose `owner_principal_id` moves, in the order they are updated. */
const OWNED_TABLES = [agents, sessions, skills, files, mcpServers, projects] as const;

/** Lock and read every local runtime key principal of the workspace, revoked and expired ones included. */
async function lockLocalKeyPrincipals(
  tx: Transaction,
  workspaceId: string,
): Promise<readonly LocalKeyPrincipal[]> {
  return tx
    .select({
      id: workspacePrincipals.id,
      actsForPrincipalId: workspacePrincipals.actsForPrincipalId,
    })
    .from(workspacePrincipals)
    .innerJoin(
      apiKeys,
      and(
        eq(apiKeys.workspaceId, workspacePrincipals.workspaceId),
        eq(apiKeys.id, workspacePrincipals.apiKeyId),
      ),
    )
    .where(
      and(
        eq(workspacePrincipals.workspaceId, workspaceId),
        eq(workspacePrincipals.kind, 'api_key'),
        // starts_with, never LIKE: a prefix holding `%` or `_` matches only itself.
        sql`starts_with(${apiKeys.name}, ${LOCAL_RUNTIME_API_KEY_NAME_PREFIX})`,
      ),
    )
    .for('update', { of: workspacePrincipals });
}

/**
 * Group the key principals by the owner their rows move to: the principal each acts for, or
 * `toPrincipalId` when it records none. Normally there is exactly one group.
 */
export function groupByOwner(
  principals: readonly LocalKeyPrincipal[],
  toPrincipalId: string,
): Map<string, string[]> {
  const byOwner = new Map<string, string[]>();
  for (const principal of principals) {
    const owner = principal.actsForPrincipalId ?? toPrincipalId;
    const group = byOwner.get(owner);
    if (group === undefined) byOwner.set(owner, [principal.id]);
    else group.push(principal.id);
  }
  return byOwner;
}

/** Move the rows owned or published by `keyPrincipalIds` to `owner`; returns how many moved. */
async function moveOwnedRows(
  tx: Transaction,
  workspaceId: string,
  owner: string,
  keyPrincipalIds: readonly string[],
): Promise<number> {
  // `updated_at` is set to itself, overriding Drizzle's `$onUpdate`, and
  // `materialised_version_id` is left alone: a change of owner is not an edit.
  let moved = 0;
  for (const table of OWNED_TABLES) {
    const rows = await tx
      .update(table)
      .set({ ownerPrincipalId: owner, updatedAt: sql`${table.updatedAt}` })
      .where(
        and(eq(table.workspaceId, workspaceId), inArray(table.ownerPrincipalId, keyPrincipalIds)),
      )
      .returning({ id: table.id });
    moved += rows.length;
  }
  const movedShares = await tx
    .update(shares)
    .set({ publisherPrincipalId: owner })
    .where(
      and(
        eq(shares.workspaceId, workspaceId),
        inArray(shares.publisherPrincipalId, keyPrincipalIds),
      ),
    )
    .returning({ id: shares.id });
  return moved + movedShares.length;
}

/** Record `toPrincipalId` as the principal each key that records none acts for. */
async function backfillActsFor(
  tx: Transaction,
  workspaceId: string,
  principals: readonly LocalKeyPrincipal[],
  toPrincipalId: string,
): Promise<void> {
  const unset = principals
    .filter((principal) => principal.actsForPrincipalId === null)
    .map((principal) => principal.id);
  if (unset.length === 0) return;
  await tx
    .update(workspacePrincipals)
    .set({ actsForPrincipalId: toPrincipalId })
    .where(
      and(
        eq(workspacePrincipals.workspaceId, workspaceId),
        inArray(workspacePrincipals.id, unset),
        isNull(workspacePrincipals.actsForPrincipalId),
      ),
    );
}

/** The repair that moves local runtime keys' resources to the member they act for. */
export function createLocalRuntimeDirectory(
  db: Database,
  workspaceId: string,
): Pick<DatabaseWorkspaceDirectory, 'reassignLocalRuntimeKeyOwnership'> {
  return {
    async reassignLocalRuntimeKeyOwnership({ toPrincipalId }) {
      return db.transaction(async (tx) => {
        // The workspace lock membership changes take, so the target cannot lose its membership
        // between the check below and the writes that reference it.
        await lockWorkspace(tx, workspaceId);
        if (!(await isActiveMembershipPrincipal(tx, workspaceId, toPrincipalId))) {
          throw new Error(
            'Local runtime key ownership can move only to an active membership principal.',
          );
        }
        const localPrincipals = await lockLocalKeyPrincipals(tx, workspaceId);
        let reassigned = 0;
        for (const [owner, keyPrincipalIds] of groupByOwner(localPrincipals, toPrincipalId)) {
          reassigned += await moveOwnedRows(tx, workspaceId, owner, keyPrincipalIds);
        }
        await backfillActsFor(tx, workspaceId, localPrincipals, toPrincipalId);
        return { reassigned };
      });
    },
  };
}
