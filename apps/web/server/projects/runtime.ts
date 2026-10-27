import type { ProjectsWorkspaceStore } from './store';

export type ProjectActor =
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
    }
  | { readonly kind: 'unauthenticated'; readonly reason: string }
  | { readonly kind: 'forbidden'; readonly reason: string };
export interface ProjectsRuntime {
  resolveActor(request: Request): Promise<ProjectActor>;
  forWorkspace(workspaceId: string): Promise<ProjectsWorkspaceStore>;
}
