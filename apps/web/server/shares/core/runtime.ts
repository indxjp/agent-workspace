import type { ShareRecord, WorkspaceSharing } from '../store';
import type { Role } from '../../rbac/roles';
import type { Ownership } from '../../rbac/decide';
import type { SharedRun } from '../session-snapshot/snapshot';

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
export type { WorkspaceSharing };
export interface SharesRuntime {
  resolveActor(request: Request): Promise<ShareActor>;
  forWorkspace(workspaceId: string): Promise<WorkspaceSharing>;
  resolvePublic(token: string): Promise<{ workspaceId: string; sharing: WorkspaceSharing } | null>;
  sharingMaterials(
    workspaceId: string,
  ): Promise<{ values: readonly string[]; referenceIds: readonly string[] }>;
  /**
   * The workspace's runs named by `runIds`, index for index, `null` where it holds none: what a
   * session share's transcript copies (ADR-0158).
   */
  sessionRuns(
    workspaceId: string,
    runIds: readonly string[],
  ): Promise<readonly (SharedRun | null)[]>;
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
