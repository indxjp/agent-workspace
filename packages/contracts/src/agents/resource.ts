import { z } from 'zod';

import { AGENT_PERMISSION_KEYS, AgentPermissionsSchema } from './permissions.js';
import { IsoDateTimeSchema, UUID_PATTERN, UuidSchema } from '../identifiers.js';
import { SkillRevisionPinsByIdSchema } from '../skills.js';

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

/** The built-in agents the platform provisions into a workspace. Closed: add a key, then every switch. */
export const BUILTIN_AGENT_KEYS = ['builder'] as const;
export const BuiltinAgentKeySchema = z.enum(BUILTIN_AGENT_KEYS);
export type BuiltinAgentKey = z.infer<typeof BuiltinAgentKeySchema>;

/** Problem codes of the built-in agents, with their HTTP status. */
export const BUILTIN_AGENT_PROBLEM_CODES = { builtin_agent_read_only: 403 } as const;

/** Every operation the item routes of one agent serve, named for the built-in refusal (#1848). */
export const BUILTIN_AGENT_OPERATIONS = [
  'read',
  'update',
  'delete',
  'update-policy',
  'replace-resources',
  'replace-grants',
  'create-version',
  'set-pointer',
  'promote',
  'rollback',
  'advance-evaluation',
  'evaluate',
  'start-evaluation-run',
  'export',
  'export-archive',
] as const;
export type BuiltinAgentOperation = (typeof BUILTIN_AGENT_OPERATIONS)[number];

/**
 * Which agent made an agent (issue #1851): the creating agent, the version of it that was running and
 * the run that saved the new agent. `agentId` is `null` once the creating agent was deleted; the
 * version and run still say how the row was made.
 */
export const AgentCreatedByAgentSchema = z
  .object({
    agentId: UuidSchema.nullable(),
    version: z.number().int().positive(),
    runId: z.string().min(1).max(128),
  })
  .strict()
  .readonly();
export type AgentCreatedByAgent = z.infer<typeof AgentCreatedByAgentSchema>;

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
    /** Present only on a built-in agent: people cannot edit it, only the platform does. */
    builtin: BuiltinAgentKeySchema.optional(),
    /**
     * Present only on an agent made by an agent. `createdBy` above stays the person (issue #1851).
     */
    createdByAgent: AgentCreatedByAgentSchema.optional(),
    /** When the agent was archived; absent while active. Lists still include archived agents. */
    archivedAt: IsoDateTimeSchema.optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();

export type AgentResource = z.infer<typeof AgentResourceSchema>;

// ── Request bodies ──────────────────────────────────────────────────────────────────────────
//
// Each refusal message names its field and what was received, because the server answers them
// verbatim as the `details` of `400 invalid_body`; `agentRequestIssueMessages` turns the issues
// into those lines. The field rules match the database constraints and spec §17.

/** Name the type of a rejected value without stringifying something huge or cyclic. */
function described(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const type = typeof value;
  if (type === 'string') return 'a string';
  if (type === 'object') return 'an object';
  return `a ${type}`;
}

/**
 * The bound is in UTF-16 code units (`String.length`), as docs/adr/W1-CP-05-input-bounds.md
 * decides. Zod's `.min`/`.max` count differently and also run on a non-string that already failed
 * its type check, so both bounds are spelled out as refinements.
 */
function tooLong(field: string, max: number) {
  return (issue: { readonly input?: unknown }) =>
    `${field} must be at most ${String(max)} characters; received ${String(typeof issue.input === 'string' ? issue.input.length : 0)}.`;
}

/**
 * `agents.name`: trimmed, then non-blank and bounded. The table's `btrim` check and its unique
 * `(workspace_id, name)` index key on the stored string, so `"Support "` must store as `"Support"`.
 */
const AgentNameRequestSchema = z
  .string({ error: (issue) => `name must be a string; received ${described(issue.input)}.` })
  .trim()
  .refine((value) => value.length > 0, { error: 'name must not be blank.' })
  .refine((value) => value.length <= AGENT_NAME_MAX_LENGTH, {
    error: tooLong('name', AGENT_NAME_MAX_LENGTH),
  });

/** `agents.instructions`: any string, empty included, never trimmed (leading space can be prose). */
const AgentInstructionsRequestSchema = z
  .string({
    error: (issue) => `instructions must be a string; received ${described(issue.input)}.`,
  })
  .refine((value) => value.length <= AGENT_INSTRUCTIONS_MAX_LENGTH, {
    error: tooLong('instructions', AGENT_INSTRUCTIONS_MAX_LENGTH),
  });

/** `agents.model`: a trimmed non-blank provider model id, or `null` for the workspace default. */
const AgentModelRequestSchema = z
  .string({
    error: (issue) => `model must be a string or null; received ${described(issue.input)}.`,
  })
  .trim()
  .refine((value) => value.length > 0, {
    error: 'model must not be blank; use null to mean "the workspace default model".',
  })
  .refine((value) => value.length <= AGENT_MODEL_MAX_LENGTH, {
    error: tooLong('model', AGENT_MODEL_MAX_LENGTH),
  })
  .nullable();

/** A `uuid` column reference, or `null`. Whether the row exists is the foreign key's question. */
function uuidOrNull(field: string) {
  const error = (issue: { readonly input?: unknown }) =>
    `${field} must be a UUID string or null; received ${described(issue.input)}.`;
  return z.string({ error }).regex(UUID_PATTERN, { error }).nullable();
}

/** One permission switch: required, because the column has no default, and a real boolean. */
function permission(key: string) {
  return z.boolean({
    error: (issue) =>
      issue.input === undefined
        ? `permissions.${key} is required; it has no default.`
        : `permissions.${key} must be a boolean; received ${described(issue.input)}.`,
  });
}

/** Exactly the four booleans of §17 Step 4; an unknown key is refused, never dropped (ADR-0015). */
const AgentPermissionsRequestSchema = z
  .object(
    {
      readFiles: permission('readFiles'),
      writeFiles: permission('writeFiles'),
      runCommands: permission('runCommands'),
      unrestrictedNetwork: permission('unrestrictedNetwork'),
    },
    {
      error: (issue) =>
        issue.code === 'invalid_type'
          ? `permissions must be an object; received ${described(issue.input)}.`
          : undefined,
    },
  )
  .strict()
  .readonly();

function bodyError(issue: { readonly code?: string; readonly input?: unknown }) {
  return issue.code === 'invalid_type'
    ? `the request body must be a JSON object; received ${described(issue.input)}.`
    : undefined;
}

/**
 * The body of `POST /api/agents`. Every field is a required key — `null` is the value that means
 * "default" for `modelConnectionId` and `model` — except `runtimeProfileId`, whose absence the
 * stores read as `null`. Unknown keys are refused so a typo is a 400, not a silently ignored field.
 */
export const CreateAgentInputSchema = z
  .object(
    {
      name: AgentNameRequestSchema,
      instructions: AgentInstructionsRequestSchema,
      modelConnectionId: uuidOrNull('modelConnectionId'),
      model: AgentModelRequestSchema,
      runtimeProfileId: uuidOrNull('runtimeProfileId').exactOptional(),
      permissions: AgentPermissionsRequestSchema,
    },
    { error: bodyError },
  )
  .strict()
  .readonly();

/** Normalized body accepted by `POST /api/agents`. */
export type CreateAgentInput = z.infer<typeof CreateAgentInputSchema>;

/**
 * The body of `PATCH /api/agents/:id`: the create fields, each optional. A present key must carry
 * a valid value (`undefined` is not "absent"), and a body that changes nothing is refused rather
 * than answered `200`.
 */
export const UpdateAgentPatchSchema = z
  .object(
    {
      name: AgentNameRequestSchema.exactOptional(),
      instructions: AgentInstructionsRequestSchema.exactOptional(),
      modelConnectionId: uuidOrNull('modelConnectionId').exactOptional(),
      model: AgentModelRequestSchema.exactOptional(),
      runtimeProfileId: uuidOrNull('runtimeProfileId').exactOptional(),
      permissions: AgentPermissionsRequestSchema.exactOptional(),
    },
    { error: bodyError },
  )
  .strict()
  .superRefine((patch, context) => {
    if (Object.keys(patch).length > 0) return;
    context.addIssue({
      code: 'custom',
      message: `the request body changed nothing; supply at least one of ${AGENT_MUTABLE_FIELDS.join(', ')}.`,
    });
  })
  .readonly();

/** Normalized body accepted by `PATCH /api/agents/:id`; omitted fields remain unchanged. */
export type UpdateAgentPatch = z.infer<typeof UpdateAgentPatchSchema>;

function within(path: readonly PropertyKey[], prefix: readonly PropertyKey[]): boolean {
  return prefix.every((key, index) => path[index] === key);
}

/**
 * The `details` lines for a refused {@link CreateAgentInputSchema} or {@link UpdateAgentPatchSchema}
 * body: one per issue, one per unknown key, and an object's unknown keys before its fields.
 */
export function agentRequestIssueMessages(issues: readonly z.core.$ZodIssue[]): string[] {
  const lines: { readonly path: readonly PropertyKey[]; readonly text: string }[] = [];
  for (const issue of issues) {
    if (issue.code !== 'unrecognized_keys') {
      lines.push({ path: issue.path, text: issue.message });
      continue;
    }
    const unknown = issue.keys.map((key) => ({
      path: issue.path,
      text:
        issue.path.length === 0
          ? `${key} is not a field of an agent; expected some of ${AGENT_MUTABLE_FIELDS.join(', ')}.`
          : `${issue.path.map(String).join('.')}.${key} is not a permission this platform knows; expected exactly ${AGENT_PERMISSION_KEYS.join(', ')}.`,
    }));
    const first = lines.findIndex((line) => within(line.path, issue.path));
    lines.splice(first === -1 ? lines.length : first, 0, ...unknown);
  }
  return lines.map((line) => line.text);
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
    /**
     * The revision each listed skill is pinned to, by skill id; a skill with no key follows
     * `latest`. Every key must be in `skillIds`. Absent when nothing is pinned.
     */
    skillRevisions: SkillRevisionPinsByIdSchema.optional(),
    connectorIds: z.array(z.string().min(1)).readonly(),
    /**
     * The folders of storage connections the agent may reach (the storage design, §05), written
     * only by a materialised version with the connection id the deploy resolved, never by a
     * client: a `PUT` keeps the stored grants and ignores this field. Absent parses to `[]`, so
     * an assignment stored before grants existed is unchanged.
     */
    storageGrants: z
      .array(
        z
          .object({
            connectionId: UuidSchema,
            prefix: z.string().min(1),
            access: z.enum(['read', 'read-write']),
          })
          .strict()
          .readonly(),
      )
      .readonly()
      .default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const listed = new Set(value.skillIds);
    for (const id of Object.keys(value.skillRevisions ?? {})) {
      if (!listed.has(id)) {
        context.addIssue({
          code: 'custom',
          path: ['skillRevisions', id],
          message: 'a pinned skill must also be in skillIds',
        });
      }
    }
  })
  .readonly();

export type AgentResourceAssignments = z.infer<typeof AgentResourceAssignmentsSchema>;
/** What a client may send: `storageGrants` is optional. */
export type AgentResourceAssignmentsInput = z.input<typeof AgentResourceAssignmentsSchema>;

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
  readonly assignments?: AgentResourceAssignmentsInput;
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
