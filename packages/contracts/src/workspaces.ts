import { z } from 'zod';

import { IsoDateTimeSchema } from './identifiers.js';
import { MEMBERSHIP_ROLES } from './team.js';

const workspaceFields = {
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  publicSharingEnabled: z.boolean(),
  /** `null` while the workspace is active. */
  archivedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
};

/** A workspace as `PATCH /api/workspaces/:id` renders it. Dates are ISO-8601 strings. */
export const WorkspaceResourceSchema = z.object(workspaceFields).strict().readonly();

export type WorkspaceResource = z.infer<typeof WorkspaceResourceSchema>;

/**
 * A workspace joined to the role the caller holds in it — every item of `GET /api/workspaces`,
 * the body of `GET /api/workspaces/:id`, and the `201` of `POST /api/workspaces`.
 */
export const WorkspaceMembershipViewSchema = z
  .object({ ...workspaceFields, role: z.enum(MEMBERSHIP_ROLES) })
  .strict()
  .readonly();

export type WorkspaceMembershipView = z.infer<typeof WorkspaceMembershipViewSchema>;

/** The body of `GET /api/workspaces`: exactly the workspaces the caller belongs to. */
export const WorkspaceListResponseSchema = z
  .object({ workspaces: z.array(WorkspaceMembershipViewSchema).readonly() })
  .strict()
  .readonly();

export type WorkspaceListResponse = z.infer<typeof WorkspaceListResponseSchema>;

/** The body of `GET /api/workspaces/:id` and `POST /api/workspaces`. */
export const WorkspaceMembershipResponseSchema = z
  .object({ workspace: WorkspaceMembershipViewSchema })
  .strict()
  .readonly();

/** The body of `PATCH /api/workspaces/:id`. */
export const WorkspaceResponseSchema = z
  .object({ workspace: WorkspaceResourceSchema })
  .strict()
  .readonly();

/** The bounds `POST /api/workspaces` applies to its two fields. */
export const WORKSPACE_NAME_MAX_LENGTH = 200;
export const WORKSPACE_SLUG_MAX_LENGTH = 64;

/** The body of `POST /api/workspaces`. `slug` is lower-case letters, digits and hyphens. */
export interface CreateWorkspaceInput {
  readonly name: string;
  readonly slug: string;
}

/** The body of `PATCH /api/workspaces/:id`: rename, archive, and/or restore. */
export interface UpdateWorkspacePatch {
  readonly name?: string;
  readonly archived?: boolean;
}

/**
 * Issue #236 (SDK-04, S-2): the JSON body of `POST /api/auth/workspace` when the caller sends
 * `Content-Type: application/json` instead of a form. `workspace` is an id or a slug, exactly as
 * the form field of the same name is read today.
 */
export const WorkspaceSwitchRequestSchema = z
  .object({ workspace: z.string().min(1) })
  .strict()
  .readonly();

export type WorkspaceSwitchRequest = z.infer<typeof WorkspaceSwitchRequestSchema>;

/**
 * The `200` of the JSON workspace switch: the membership the caller's session now carries, in the
 * same shape `GET /api/workspaces/:id` renders one. The new session cookie travels as `Set-Cookie`,
 * never in this body.
 */
export const WorkspaceSwitchResponseSchema = z
  .object({ workspace: WorkspaceMembershipViewSchema })
  .strict()
  .readonly();

export type WorkspaceSwitchResponse = z.infer<typeof WorkspaceSwitchResponseSchema>;

/**
 * The workspace's sharing policy, as `GET /api/sharing-policies` and `PATCH /api/sharing-policies`
 * both render it. `publicSharing` is whether a member may publish a public (`/p/<token>`) share;
 * it is the same fact `WorkspaceResource.publicSharingEnabled` reports, read through the sharing
 * routes so every role can see it.
 */
export const SharingPolicySchema = z.object({ publicSharing: z.boolean() }).strict().readonly();

export type SharingPolicy = z.infer<typeof SharingPolicySchema>;

/**
 * The body of `PATCH /api/sharing-policies`. Only an Owner may change the policy (`403 forbidden`
 * for every other role); a body whose `publicSharing` is not a boolean is `400 invalid_policy`,
 * and one that is not JSON is `400 invalid_share`.
 */
export interface UpdateSharingPolicyInput {
  readonly publicSharing: boolean;
}
