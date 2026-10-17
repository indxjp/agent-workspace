import { z } from 'zod';

import { AgentPermissionsSchema } from './permissions.js';
import { AGENT_POLICY_SOURCES, AgentPolicySchema } from './policy.js';
import {
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  AGENT_MODEL_MAX_LENGTH,
  AGENT_NAME_MAX_LENGTH,
} from './resource.js';
import { SKILL_NAME_PATTERN } from '../skills.js';

// ── Agent definition (K-1; spec §6.2) ────────────────────────────────────────────────────

/**
 * The `apiVersion` every portable agent definition carries. It is a stable file-format version,
 * not the contracts package's release number: a definition written today stays readable by every
 * release that still accepts `agentworkspace.dev/v1`, and a breaking change to the shape — to
 * {@link AgentPolicySchema} or {@link AgentPermissionsSchema} included, since a definition embeds
 * both — is a new version string rather than a silent reinterpretation. It is the group the
 * workspace-as-code files of the developer platform's Phase 2 share. ADR-0076 records the choice.
 */
export const AGENT_DEFINITION_API_VERSION = 'agentworkspace.dev/v1';
export const AGENT_DEFINITION_KIND = 'AgentDefinition';

/** Bound on each name list, so a hostile file cannot make an import fan out without limit. */
export const AGENT_DEFINITION_MAX_REFERENCES = 1_000;

/** Bound on one file grant's workspace path, so a hostile file cannot carry an unbounded string. */
export const AGENT_DEFINITION_FILE_PATH_MAX_LENGTH = 1_024;

const DefinitionNameSchema = z.string().min(1).max(AGENT_NAME_MAX_LENGTH);

/**
 * The agent record of a definition: every field that describes the agent, with each reference to
 * another resource replaced by that resource's **name** in the destination workspace. No id,
 * workspace, owner or timestamp — those belong to the workspace the agent lives in, not to it.
 */
export const AgentDefinitionAgentSchema = z
  .object({
    name: z.string().min(1).max(AGENT_NAME_MAX_LENGTH),
    instructions: z.string().max(AGENT_INSTRUCTIONS_MAX_LENGTH),
    permissions: AgentPermissionsSchema,
    model: z.string().min(1).max(AGENT_MODEL_MAX_LENGTH).nullable(),
    /** The model connection's name, or `null` for the deployment default. */
    modelConnectionName: DefinitionNameSchema.nullable(),
    /**
     * The runtime profile's name, or `null` for the workspace's default runtime profile (none:
     * runs are refused until the agent names one).
     */
    runtimeProfileName: DefinitionNameSchema.nullable(),
  })
  .strict()
  .readonly();
export type AgentDefinitionAgent = z.infer<typeof AgentDefinitionAgentSchema>;

/** The agent's resource assignments, by workspace path and by name — never by id. */
export const AgentDefinitionResourcesSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(AGENT_DEFINITION_FILE_PATH_MAX_LENGTH),
            access: z.enum(['read', 'read-write']),
          })
          .strict()
          .readonly(),
      )
      .max(AGENT_DEFINITION_MAX_REFERENCES)
      .readonly(),
    skills: z
      .array(z.string().regex(SKILL_NAME_PATTERN))
      .max(AGENT_DEFINITION_MAX_REFERENCES)
      .readonly(),
    connectors: z.array(DefinitionNameSchema).max(AGENT_DEFINITION_MAX_REFERENCES).readonly(),
  })
  .strict()
  .readonly();
export type AgentDefinitionResources = z.infer<typeof AgentDefinitionResourcesSchema>;

/**
 * K-1: one agent as a portable file (`agent.json`) — what `aw.agents.export(id)` produces and
 * `aw.agents.import(definition)` recreates in any workspace.
 *
 * - **Name-keyed.** Skills, connectors, the model connection, the runtime profile and files are
 *   referenced by name (files by workspace path), and resolved inside the destination at import.
 * - **Carries no secret and no bytes.** There is no credential field anywhere in the shape, and
 *   `.strict()` refuses a file that smuggles one in under any key; a connector's or a model
 *   connection's credential stays in the workspace it was entered into. A skill travels by name
 *   only — its bytes move with `skills.export`/`skills.import`, never with an agent.
 * - **Not carried:** run grants (`/grants`) name principals of one workspace and mean nothing in
 *   another, so they are left for the destination to decide.
 *
 * `policy` is {@link AgentPolicySchema} verbatim: its skill allowlist and tool rules already speak
 * in names, and an allowlist may only name skills `resources.skills` assigns. The agent's engine
 * is `policy.engine`. `policySource` records whether the source agent's policy was stored
 * (`'stored'`, the default when a hand-written file leaves it out) or compiled from its
 * permissions and skills (`'compiled'`); import stores only a stored one, so a compiled policy
 * stays compiled in the destination. See ADR-0076 and spec 04 §6.2.
 */
export const AgentDefinitionSchema = z
  .object({
    apiVersion: z.literal(AGENT_DEFINITION_API_VERSION),
    kind: z.literal(AGENT_DEFINITION_KIND),
    agent: AgentDefinitionAgentSchema,
    policy: AgentPolicySchema,
    policySource: z.enum(AGENT_POLICY_SOURCES).default('stored'),
    resources: AgentDefinitionResourcesSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.policy.skills.mode !== 'allowlist') return;
    const assigned = new Set(value.resources.skills);
    for (const [index, name] of value.policy.skills.names.entries()) {
      if (!assigned.has(name)) {
        context.addIssue({
          code: 'custom',
          path: ['policy', 'skills', 'names', index],
          message: `the allowlist names the skill ${JSON.stringify(name)}, which resources.skills does not assign`,
        });
      }
    }
  })
  .readonly();
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/**
 * What `agents.import` does with a name the destination does not have: `'fail'` (the default)
 * refuses before anything is written; `'skip'` drops the reference — the assignment, the
 * policy's allowlist entry, or the model connection / runtime profile, which falls back to the
 * deployment default.
 */
export const AGENT_DEFINITION_ON_MISSING = ['fail', 'skip'] as const;
export type AgentDefinitionOnMissing = (typeof AGENT_DEFINITION_ON_MISSING)[number];

/** The kinds of reference a definition resolves, as they prefix each `details` entry. */
export const AGENT_DEFINITION_REFERENCE_KINDS = [
  'skill',
  'connector',
  'file',
  'model-connection',
  'runtime-profile',
] as const;
export type AgentDefinitionReferenceKind = (typeof AGENT_DEFINITION_REFERENCE_KINDS)[number];

/**
 * Problem codes `agents.export`/`agents.import` raise **themselves** — the two operations are a
 * client-side composition of existing routes (no route answers them), so the SDK raises these as
 * an `ApiProblemError` in the one error envelope, with the status each travels under. Each code
 * documents its `details` shape, so a caller lists the offending references without parsing the
 * message. Nothing is written when an import refusal other than the last is raised.
 *
 * If import has created the agent, a later step fails, and removing the agent again fails too, the
 * error is the **original** refusal — same status and code — with one more `details` entry,
 * `agent:<id>` ({@link AGENT_DEFINITION_ORPHAN_DETAIL_PREFIX}), naming the agent left behind. A
 * failure that was not an `ApiProblemError` (an abort, a network error) becomes
 * `agent_definition_import_incomplete`, with the original failure as its `cause`.
 */
export const AGENT_DEFINITION_PROBLEM_CODES = {
  /**
   * The file is not an {@link AgentDefinitionSchema}; each `details` entry is one parse issue,
   * `<dotted.path>: <message>` (`(root)` for the file itself).
   */
  invalid_agent_definition: 400,
  /** The policy names an engine this deployment does not install; `details` is `[<engine id>]`. */
  unsupported_engine: 400,
  /**
   * One or more names do not exist in the destination (and `onMissing` is `'fail'`); each `details`
   * entry is `<kind>:<name>` ({@link AGENT_DEFINITION_REFERENCE_KINDS}; a file's name is its path).
   */
  agent_definition_references_missing: 422,
  /**
   * A name matches more than one resource in the destination, so no choice is made for you; each
   * `details` entry is `<kind>:<name>`.
   */
  agent_definition_reference_ambiguous: 409,
  /**
   * Export only: an assigned resource's name could not be read back from the source; each `details`
   * entry is `<kind>:<source id>` — the id, because there is no name to report.
   */
  agent_definition_reference_unresolvable: 409,
  /**
   * Import only: the agent was created, a later step failed with something other than an
   * `ApiProblemError`, and removing the agent again failed as well. `details` is `[agent:<id>]`.
   */
  agent_definition_import_incomplete: 409,
} as const;

/** The `details` prefix naming an agent an import created but could not remove again. */
export const AGENT_DEFINITION_ORPHAN_DETAIL_PREFIX = 'agent:';
export type AgentDefinitionProblemCode = keyof typeof AGENT_DEFINITION_PROBLEM_CODES;
