import { z } from 'zod';

import { AGENT_NAME_MAX_LENGTH } from './agents.js';
import { IsoDateTimeSchema, UuidSchema } from './identifiers.js';
import { TOOL_NAME_MAX_LENGTH } from './tool-connectors.js';

/**
 * Agent teams (ADR-0104, accepted for `handoff` mode; spec 04 §5.18). An agent team is a published
 * unit (ADR-0101) with a lead agent and up to {@link AGENT_TEAM_MEMBERS_MAX} member agents of the
 * same workspace. The lead sees each member as the tool `agent__<member name>`. A team version is
 * immutable, numbered per team, and pins `(agentId, agentVersionId)` for the lead and for every
 * member, so a team run is reproducible.
 *
 * "Team" alone means the people of a workspace (`./team`), so every layer says _agent team_
 * (ADR-0104 acceptance decision 1, ADR-0114). This module is the wire contract only: the tables
 * live in `packages/core`, and the routes, the SDK client and the CLI land with them.
 */

/** The team modes ADR-0104 accepts. `switcher` stays proposed (acceptance decision 2). */
export const AGENT_TEAM_MODES = ['handoff'] as const;
export type AgentTeamMode = (typeof AGENT_TEAM_MODES)[number];
/** {@link AGENT_TEAM_MODES} as a schema. */
export const AgentTeamModeSchema = z.enum(AGENT_TEAM_MODES);

/** The most members one team version holds (ADR-0104 acceptance decision 6). */
export const AGENT_TEAM_MEMBERS_MAX = 8;

/** The most child runs one root run may start (ADR-0104 acceptance decision 6). */
export const AGENT_TEAM_CHILD_RUNS_MAX = 16;

/** The neutral prefix of a member tool: the lead calls member `x` as `agent__x` (decision 3). */
export const AGENT_TEAM_MEMBER_TOOL_PREFIX = 'agent__';

/**
 * The longest member name: `mcp__agent__<member name>`, the Claude engine's spelling of a member
 * tool, must fit {@link TOOL_NAME_MAX_LENGTH} (ADR-0104 acceptance decision 3), so 52 characters.
 */
export const AGENT_TEAM_MEMBER_NAME_MAX_LENGTH = TOOL_NAME_MAX_LENGTH - 'mcp__agent__'.length;

/** A member name is a team-local slug (decision 3). */
export const AGENT_TEAM_MEMBER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;

/** Whether `name` is a valid member name: a slug of at most 52 characters. */
export function isAgentTeamMemberName(name: string): boolean {
  return (
    name.length <= AGENT_TEAM_MEMBER_NAME_MAX_LENGTH && AGENT_TEAM_MEMBER_NAME_PATTERN.test(name)
  );
}

/**
 * The name a member gets when its request names none: its agent's name, when that is a valid
 * member name, and otherwise `null`, which the write refuses as `422 agent_team_member_invalid`
 * (spec 04 §5.18).
 */
export function defaultAgentTeamMemberName(agentName: string): string | null {
  return isAgentTeamMemberName(agentName) ? agentName : null;
}

/** A member name as a request carries it. */
export const AgentTeamMemberNameSchema = z.string().refine(isAgentTeamMemberName, {
  error: `must be a slug ([a-z0-9][a-z0-9_-]*) of at most ${String(AGENT_TEAM_MEMBER_NAME_MAX_LENGTH)} characters`,
});

/**
 * A team's name: the agent name grammar (trimmed, non-blank, at most `AGENT_NAME_MAX_LENGTH`
 * characters in UTF-16 code units), unique among the workspace's teams that are not deleted.
 */
export const AgentTeamNameSchema = z
  .string()
  .trim()
  .refine((value) => value.length > 0, { error: 'must not be blank' })
  .refine((value) => value.length <= AGENT_NAME_MAX_LENGTH, {
    error: `must be at most ${String(AGENT_NAME_MAX_LENGTH)} characters`,
  });

/** The longest team description, in characters. */
export const AGENT_TEAM_DESCRIPTION_MAX_LENGTH = 1000;

const AgentTeamDescriptionSchema = z.string().max(AGENT_TEAM_DESCRIPTION_MAX_LENGTH);

/** The largest version number: PostgreSQL's `integer` maximum, as for agent versions. */
const AgentTeamVersionNumberSchema = z.number().int().min(1).max(2_147_483_647);

/** One pinned agent version: the agent and the exact version of it that runs. */
export const AgentTeamPinSchema = z
  .object({ agentId: UuidSchema, agentVersionId: UuidSchema })
  .strict()
  .readonly();
export type AgentTeamPin = z.infer<typeof AgentTeamPinSchema>;

/** One member as a version request names it; `name` defaults to the agent's name. */
export const AgentTeamMemberRequestSchema = z
  .object({
    name: AgentTeamMemberNameSchema.exactOptional(),
    agentId: UuidSchema,
    agentVersionId: UuidSchema,
  })
  .strict()
  .readonly();

/**
 * The body of `POST /api/agent-teams/:id/versions`: the lead and 1–8 members, each pinned to a
 * version. A member appears once, the lead is not a member, and member names do not repeat. That
 * every agent and version belongs to the workspace is the server's check, answered as
 * `422 agent_team_member_invalid`.
 */
export const CreateAgentTeamVersionRequestSchema = z
  .object({
    lead: AgentTeamPinSchema,
    members: z.array(AgentTeamMemberRequestSchema).min(1).max(AGENT_TEAM_MEMBERS_MAX).readonly(),
  })
  .strict()
  .superRefine((request, context) => {
    const agents = new Set<string>();
    const names = new Set<string>();
    for (const [index, member] of request.members.entries()) {
      if (member.agentId === request.lead.agentId) {
        context.addIssue({
          code: 'custom',
          path: ['members', index, 'agentId'],
          message: 'the lead agent must not also be a member',
        });
      }
      if (agents.has(member.agentId)) {
        context.addIssue({
          code: 'custom',
          path: ['members', index, 'agentId'],
          message: 'must not repeat an agent',
        });
      }
      agents.add(member.agentId);
      if (member.name !== undefined) {
        if (names.has(member.name)) {
          context.addIssue({
            code: 'custom',
            path: ['members', index, 'name'],
            message: 'must not repeat a member name',
          });
        }
        names.add(member.name);
      }
    }
  })
  .readonly();
export type CreateAgentTeamVersionRequest = z.infer<typeof CreateAgentTeamVersionRequestSchema>;

/** The body of `POST /api/agent-teams`; `version`, when given, is saved as version 1. */
export const CreateAgentTeamRequestSchema = z
  .object({
    name: AgentTeamNameSchema,
    description: AgentTeamDescriptionSchema.exactOptional(),
    version: CreateAgentTeamVersionRequestSchema.exactOptional(),
  })
  .strict()
  .readonly();
export type CreateAgentTeamRequest = z.infer<typeof CreateAgentTeamRequestSchema>;

/** One member of a saved version. */
export const AgentTeamMemberSchema = z
  .object({ name: AgentTeamMemberNameSchema, agentId: UuidSchema, agentVersionId: UuidSchema })
  .strict()
  .readonly();
export type AgentTeamMember = z.infer<typeof AgentTeamMemberSchema>;

/** One saved, immutable team version (spec 04 §5.18). `createdBy` is the user, as on agents. */
export const AgentTeamVersionSchema = z
  .object({
    id: UuidSchema,
    teamId: UuidSchema,
    workspaceId: UuidSchema,
    version: AgentTeamVersionNumberSchema,
    mode: AgentTeamModeSchema,
    lead: AgentTeamPinSchema,
    members: z.array(AgentTeamMemberSchema).min(1).max(AGENT_TEAM_MEMBERS_MAX).readonly(),
    createdBy: UuidSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();
export type AgentTeamVersion = z.infer<typeof AgentTeamVersionSchema>;

/** An agent team as it crosses the HTTP boundary, with its newest version (spec 04 §5.18). */
export const AgentTeamResourceSchema = z
  .object({
    id: UuidSchema,
    workspaceId: UuidSchema,
    name: z.string().min(1),
    description: z.string().nullable(),
    latestVersion: AgentTeamVersionSchema.nullable(),
    ownerPrincipalId: UuidSchema,
    createdBy: UuidSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();
export type AgentTeamResource = z.infer<typeof AgentTeamResourceSchema>;

/** The largest page `GET /api/agent-teams?limit=` and the version list serve (ADR-0079). */
export const AGENT_TEAM_LIST_MAX_LIMIT = 200;

/** The body of `GET /api/agent-teams`: newest first, and the next page's cursor (ADR-0079). */
export const AgentTeamListResponseSchema = z
  .object({
    items: z.array(AgentTeamResourceSchema).readonly(),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict()
  .readonly();
export type AgentTeamListResponse = z.infer<typeof AgentTeamListResponseSchema>;

/** The body of `GET /api/agent-teams/:id/versions`: newest first, cursor paged (ADR-0079). */
export const AgentTeamVersionListResponseSchema = z
  .object({
    items: z.array(AgentTeamVersionSchema).readonly(),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict()
  .readonly();
export type AgentTeamVersionListResponse = z.infer<typeof AgentTeamVersionListResponseSchema>;

/**
 * The problem codes the agent-team routes own, with their statuses (spec 04 §5.18). The common
 * vocabulary (`invalid_body`, `forbidden`, …) is `COMMON_PROBLEM_CODES`.
 */
export const AGENT_TEAM_PROBLEM_CODES = {
  /** The team id in the route's path is not a UUID. */
  invalid_agent_team_id: 400,
  /** No team with that id in this workspace, or it was deleted. */
  agent_team_not_found: 404,
  /** Another team of the workspace that is not deleted has the name. */
  agent_team_name_taken: 409,
  /**
   * A lead or member that is not an agent version of the workspace, the lead listed as a member, a
   * member name that is not a valid slug or repeats, or more than 8 members.
   */
  agent_team_member_invalid: 422,
  /** `POST /api/agent-teams/:id/runs` on a team that has no version yet: there is no lead to run. */
  agent_team_has_no_version: 409,
} as const;
export type AgentTeamProblemCode = keyof typeof AGENT_TEAM_PROBLEM_CODES;

/**
 * The tool errors a member call returns to the lead: a tool result, never an HTTP problem
 * (decisions 5 and 6). Nothing is started for `team_member_limit` (a call over 16 child runs of
 * one root), `team_member_unknown` (no member of that name), `team_member_invalid_arguments` (no
 * `prompt` of 1 to 100 000 characters), `team_member_forbidden` (the person the root acts for may
 * not run the member, or no person is behind the root) and `team_member_refused` (the start was
 * refused; `failure` carries the run-start code). A started member run that stops other than
 * `completed` answers `team_member_failed` (`failure` is its public failure code, or `null`),
 * `team_member_cancelled` or `team_member_paused` (it waits on an approval), and one still going
 * when the root runs out of time is interrupted and answers `team_member_timeout`.
 */
export const AGENT_TEAM_TOOL_ERROR_CODES = [
  'team_member_limit',
  'team_member_unknown',
  'team_member_invalid_arguments',
  'team_member_forbidden',
  'team_member_refused',
  'team_member_failed',
  'team_member_cancelled',
  'team_member_paused',
  'team_member_timeout',
] as const;
export type AgentTeamToolErrorCode = (typeof AGENT_TEAM_TOOL_ERROR_CODES)[number];
