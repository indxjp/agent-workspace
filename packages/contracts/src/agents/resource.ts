import { z } from 'zod';

import { AgentPermissionsSchema, type AgentPermissions } from './permissions.js';
import { IsoDateTimeSchema, UuidSchema } from '../identifiers.js';

// The database columns are unbounded text. These HTTP bounds limit memory amplification and are
// measured in JavaScript string code units; docs/adr/W1-CP-05-input-bounds.md records the decision.
export const AGENT_NAME_MAX_LENGTH = 200;
export const AGENT_INSTRUCTIONS_MAX_LENGTH = 100_000;
export const AGENT_MODEL_MAX_LENGTH = 200;

/** The keys `PATCH` accepts and `POST` requires, kept in one shared vocabulary. */
export const AGENT_MUTABLE_FIELDS = [
  'name',
  'instructions',
  'modelConnectionId',
  'model',
  'runtimeProfileId',
  'permissions',
] as const;

/**
 * One agent as it crosses the HTTP boundary — the body of `GET /api/agents/:id`, the `201` of
 * `POST /api/agents`, the `200` of `PATCH /api/agents/:id`, and every item of the list. Dates are
 * ISO-8601 strings.
 */
export const AgentResourceSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    name: z.string().min(1),
    instructions: z.string(),
    modelConnectionId: z.string().nullable(),
    model: z.string().nullable(),
    runtimeProfileId: z.string().nullable(),
    permissions: AgentPermissionsSchema,
    /** Legacy human creator attribution, or `null` when an API-key principal created the row. */
    createdBy: z.string().min(1).nullable(),
    ownerPrincipalId: z.string().min(1),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();

export type AgentResource = z.infer<typeof AgentResourceSchema>;

/** Normalized body accepted by `POST /api/agents`. */
export interface CreateAgentInput {
  readonly name: string;
  readonly instructions: string;
  readonly modelConnectionId: string | null;
  readonly model: string | null;
  readonly runtimeProfileId?: string | null;
  readonly permissions: AgentPermissions;
}

/** Normalized body accepted by `PATCH /api/agents/:id`; omitted fields remain unchanged. */
export interface UpdateAgentPatch {
  readonly name?: string;
  readonly instructions?: string;
  readonly modelConnectionId?: string | null;
  readonly model?: string | null;
  readonly runtimeProfileId?: string | null;
  readonly permissions?: AgentPermissions;
}

/** The `GET`/`PUT /api/agents/:id/resources` payload: what the agent is allowed to reach. */
export const AgentResourceAssignmentsSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            fileId: z.string().min(1),
            access: z.enum(['read', 'read-write']),
          })
          .strict()
          .readonly(),
      )
      .readonly(),
    skillIds: z.array(z.string().min(1)).readonly(),
    connectorIds: z.array(z.string().min(1)).readonly(),
  })
  .strict()
  .readonly();

export type AgentResourceAssignments = z.infer<typeof AgentResourceAssignmentsSchema>;

/** The complete set of membership principals permitted to run one agent. */
export const AgentGrantsSchema = z
  .object({
    principalIds: z
      .array(UuidSchema.transform((principalId) => principalId.toLowerCase()))
      .readonly(),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, principalId] of value.principalIds.entries()) {
      if (seen.has(principalId)) {
        context.addIssue({
          code: 'custom',
          path: ['principalIds', index],
          message: 'principal ids must be unique',
        });
      }
      seen.add(principalId);
    }
  })
  .readonly();

export type AgentGrants = z.infer<typeof AgentGrantsSchema>;

/** The body of `GET /api/agents`. */
export const AgentListResponseSchema = z
  .object({ agents: z.array(AgentResourceSchema).readonly() })
  .strict()
  .readonly();

export type AgentListResponse = z.infer<typeof AgentListResponseSchema>;

export const AgentResourceAssignmentsResponseSchema = z
  .object({ assignments: AgentResourceAssignmentsSchema })
  .strict()
  .readonly();

/**
 * K-2: the body `agents.create(input, { assignments })` posts to `POST /api/agents` in one
 * request, and the `201` it gets back — the same rows `create` followed by
 * `replaceResourceAssignments` would have produced, written atomically by the server.
 */
export interface CreateAgentOptions {
  readonly assignments?: AgentResourceAssignments;
}

export const CreateAgentWithAssignmentsResponseSchema = z
  .object({
    agent: AgentResourceSchema,
    assignments: AgentResourceAssignmentsSchema,
  })
  .strict()
  .readonly();

export type CreateAgentWithAssignmentsResponse = z.infer<
  typeof CreateAgentWithAssignmentsResponseSchema
>;
