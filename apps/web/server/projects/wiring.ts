import type { Caller } from '../identity';
import type { ProjectsWorkspaceStore } from './store';

/**
 * Who calls a project route: the fields of the one {@link Caller} type the routes read (part 06
 * step 9), or why there is none. `ownerPrincipalId` is the owner of what this caller writes
 * (issue #509); it is required, as on Caller (`rbac/core/owner-principal.ts`).
 */
export type ProjectActor =
  | ({ readonly kind: 'workspace' } & Pick<
      Caller,
      'workspaceId' | 'principalId' | 'ownerPrincipalId' | 'userId' | 'label'
    >)
  | { readonly kind: 'unauthenticated'; readonly reason: string }
  | { readonly kind: 'forbidden'; readonly reason: string };
export interface ProjectsRuntime {
  resolveActor(request: Request): Promise<ProjectActor>;
  forWorkspace(workspaceId: string): Promise<ProjectsWorkspaceStore>;
}
