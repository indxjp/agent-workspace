import { z } from 'zod';

import { IsoDateTimeSchema } from './identifiers.js';

export const PROJECT_VISIBILITIES = ['private', 'workspace', 'public'] as const;
export type ProjectVisibility = (typeof PROJECT_VISIBILITIES)[number];

/**
 * One project as `GET /api/projects/:id`, the `201` of `POST /api/projects`, the `200` of
 * `PATCH /api/projects/:id`, `POST /api/projects/:id/archive|restore`, and every list item
 * render it.
 */
export const ProjectResourceSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    name: z.string().min(1),
    instructions: z.string().nullable(),
    defaultAgentId: z.string().nullable(),
    defaultModelConnectionId: z.string().nullable(),
    defaultModel: z.string().nullable(),
    visibility: z.enum(PROJECT_VISIBILITIES),
    createdBy: z.string().min(1).nullable(),
    ownerPrincipalId: z.string().min(1),
    /**
     * When the project was archived, or `null` while it is active. Published because the archive
     * route answers with this same resource: without it an archived project and an active one are
     * byte-identical over HTTP.
     */
    archivedAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    fileIds: z.array(z.string()),
    mcpServerIds: z.array(z.string()),
  })
  .strict();

export type ProjectResource = z.infer<typeof ProjectResourceSchema>;

/** Normalized body accepted by `POST /api/projects`. */
export interface ProjectCreateInput {
  name: string;
  instructions?: string;
  defaultAgentId?: string | null;
  visibility: ProjectVisibility;
  fileIds: readonly string[];
  mcpServerIds: readonly string[];
}

/** Normalized body accepted by `PATCH /api/projects/:id`; omitted fields remain unchanged. */
export interface ProjectPatchInput {
  name?: string;
  instructions?: string | null;
  defaultAgentId?: string | null;
  defaultModelConnectionId?: string | null;
  defaultModel?: string | null;
  visibility?: ProjectVisibility;
  fileIds?: readonly string[];
  mcpServerIds?: readonly string[];
}

/** The `?archived=` filter of `GET /api/projects`; the default is `active`. */
export const PROJECT_LIST_FILTERS = ['active', 'archived', 'all'] as const;
export type ProjectListFilter = (typeof PROJECT_LIST_FILTERS)[number];

/** The body of `GET /api/projects`. */
export const ProjectListResponseSchema = z
  .object({ projects: z.array(ProjectResourceSchema) })
  .strict();

export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;

/**
 * The `201` (created) or `200` (already existed) body of `POST /api/projects/:id/sessions` when
 * it starts a session, so a first run can be attributed to the project before it happens.
 */
export const ProjectSessionResponseSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    agentId: z.string().min(1),
  })
  .strict()
  .readonly();

export type ProjectSessionResponse = z.infer<typeof ProjectSessionResponseSchema>;

/**
 * The `200` body of `POST /api/projects/:id/sessions` when the body names a `sessionId`: the
 * session now belongs to the project. The route refuses the move once the session has any run
 * (`409 project_session_has_runs`), so a run's project attribution is never rewritten.
 */
export const ProjectSessionMoveResponseSchema = z
  .object({
    projectId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict()
  .readonly();

export type ProjectSessionMoveResponse = z.infer<typeof ProjectSessionMoveResponseSchema>;
