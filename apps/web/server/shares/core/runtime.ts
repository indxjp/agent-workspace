import type {
  AuditEventRepository,
  ShareRepository,
  ShareViewRepository,
  ShareRecord,
} from '@agent-workspace/core/db';
import type { Role } from '../../rbac/roles';
import type { Ownership } from '../../rbac/decide';

export type ShareActor =
  | {
      readonly kind: 'workspace';
      readonly workspaceId: string;
      readonly principalId: string;
      /**
       * The owner of what this actor writes (`Principal.ownerPrincipalId`, issue #509). Every
       * composition root sets it, so it is required (`rbac/owner-principal.ts`).
       */
      readonly ownerPrincipalId: string;
      readonly userId: string | null;
      readonly userLabel: string;
      readonly role: Role;
    }
  | { readonly kind: 'unauthenticated'; readonly reason: string }
  | { readonly kind: 'forbidden'; readonly reason: string };
export interface WorkspaceSharing {
  readonly shares: ShareRepository;
  readonly views: ShareViewRepository;
  readonly audit: AuditEventRepository;
}
export interface SharesRuntime {
  resolveActor(request: Request): Promise<ShareActor>;
  forWorkspace(workspaceId: string): Promise<WorkspaceSharing>;
  resolvePublic(token: string): Promise<{ workspaceId: string; sharing: WorkspaceSharing } | null>;
  sharingMaterials(
    workspaceId: string,
  ): Promise<{ values: readonly string[]; referenceIds: readonly string[] }>;
  subjectOwnership(input: {
    workspaceId: string;
    /** The caller's owner principal (`ShareActor.ownerPrincipalId`), compared with the subject's. */
    principalId: string;
    subjectType: unknown;
    subjectId: unknown;
  }): Promise<Ownership>;
  runPublic(input: {
    workspaceId: string;
    share: ShareRecord;
    prompt: string;
    sessionId: string;
  }): Promise<{ output: unknown; runId: string }>;
}
interface Registry {
  __agentWorkspaceSharesRuntime__?: SharesRuntime;
}
const registry = globalThis as typeof globalThis & Registry;
export function configureSharesRuntime(runtime: SharesRuntime): void {
  registry.__agentWorkspaceSharesRuntime__ = runtime;
}
export function clearSharesRuntime(): void {
  delete registry.__agentWorkspaceSharesRuntime__;
}
export function currentSharesRuntime(): SharesRuntime | null {
  return registry.__agentWorkspaceSharesRuntime__ ?? null;
}
