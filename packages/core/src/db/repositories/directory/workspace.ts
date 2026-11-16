import type { Database } from '../../client.js';
import type { DatabaseWorkspaceDirectory } from '../directory.js';
import { createApiKeyDirectory } from './api-keys.js';
import { createInvitationDirectory } from './invitations.js';
import { createLocalRuntimeDirectory } from './local-runtime.js';
import { createMembershipDirectory } from './memberships.js';

export function createDatabaseWorkspaceDirectory(
  db: Database,
  workspaceId: string,
): DatabaseWorkspaceDirectory {
  return {
    ...createMembershipDirectory(db, workspaceId),
    ...createApiKeyDirectory(db, workspaceId),
    ...createLocalRuntimeDirectory(db, workspaceId),
    ...createInvitationDirectory(db, workspaceId),
  };
}
