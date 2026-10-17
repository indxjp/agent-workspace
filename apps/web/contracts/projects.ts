/**
 * The project wire contract lives in `@indx-workspace/contracts/projects`; this module re-exports
 * it as the application's import seam (see `./agents.ts`). What stays here is the one value that is
 * not a wire contract: the server-to-component capability prop below.
 */
export {
  ProjectListResponseSchema,
  ProjectResourceSchema,
  type ProjectCreateInput,
  type ProjectPatchInput,
  type ProjectResource,
} from '@indx-workspace/contracts/projects';

/**
 * Whether the signed-in caller may archive or restore a project, answered by the server's own
 * decision table and handed to the browser as a prop (issue #184).
 *
 * It lives beside the wire contracts rather than in either half because it crosses the same kind of
 * boundary: `apps/web/server/projects/archive-capability.ts` produces it by asking the single
 * `decide()` table the archive routes themselves consult, and
 * `apps/web/components/projects/**` consumes it. Neither side may import the other, and the value
 * is serialised across the server/client component boundary on its way over.
 *
 * The two grants are split by ownership because `requireProjectAccess` splits them: a Builder may
 * retire a project they created and not one somebody else did. The browser's only remaining logic
 * is comparing `ownerPrincipalId` against {@link ProjectArchiveCapability.viewerPrincipalId} — a
 * fact about the request, not a copy of the permission table. `viewerPrincipalId` is `null` when
 * the session, the RBAC runtime, or the principal could not be resolved; both grants are then
 * `false` too, because an undecidable check denies (ADR-0015).
 */
export interface ProjectArchiveCapability {
  readonly canArchiveOwn: boolean;
  readonly canArchiveOther: boolean;
  readonly viewerPrincipalId: string | null;
}
