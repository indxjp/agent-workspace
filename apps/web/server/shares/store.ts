/**
 * The shares domain's persistence port — the one module of `apps/web/server/shares` that names
 * `@agent-workspace/core/db` (F-08, W3-5). The share services, the policy, the routes and the
 * public page depend on the narrow views declared here; the composition root
 * (`../composition/register.ts`) hands the tenant-scoped repositories in, which satisfy them
 * structurally. Copies the shape of `../projects/store.ts`.
 */
import type {
  AgentPermissions,
  AuditEventRepository,
  CreateShareInput,
  ShareRecord,
  ShareRepository,
  ShareViewRepository,
} from '@agent-workspace/core/db';

/** The stored share, the row a publish writes, and the permissions a public run narrows. */
export type { AgentPermissions, CreateShareInput, ShareRecord };

/** The share-row operations the shares domain performs inside one workspace. */
export type ShareRows = Pick<
  ShareRepository,
  | 'create'
  | 'findByToken'
  | 'get'
  | 'list'
  | 'revoke'
  | 'stop'
  | 'reserveVisitorMessage'
  | 'getPublicSharingEnabled'
  | 'setPublicSharingEnabled'
>;

/** The port: everything one workspace's sharing reads or writes. */
export interface WorkspaceSharing {
  readonly shares: ShareRows;
  readonly views: Pick<ShareViewRepository, 'record' | 'count'>;
  readonly audit: Pick<AuditEventRepository, 'write'>;
}
