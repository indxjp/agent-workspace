import { z } from 'zod';

import {
  AGENT_DEFINITION_FILE_PATH_MAX_LENGTH,
  AGENT_DEFINITION_MAX_REFERENCES,
  AGENT_NAME_MAX_LENGTH,
  AgentDefinitionSchema,
} from '../agents.js';
import { IsoDateTimeSchema } from '../identifiers.js';
import {
  PORTABLE_AGENT_DESCRIPTION_MAX_LENGTH,
  PORTABLE_AGENT_LIST_MAX,
  PORTABLE_AGENT_SUBAGENTS_MAX,
} from '../portable-agent.js';
import { SurfaceDefinitionSchema } from '../surfaces.js';
import {
  AGENT_VERSION_SUMMARY_MAX_LENGTH,
  AGENT_VERSION_SURFACES_MAX,
  AgentVersionNumberSchema,
  AgentVersionViaSchema,
  ClientAgentVersionViaSchema,
} from './vocabulary.js';
import { AgentVersionToolBundleSchema } from './tool-bundles.js';

/** The fields of a version body, before the cross-field rules of {@link AgentVersionBodySchema}. */
const AgentVersionBodyShapeSchema = z
  .object({
    definition: AgentDefinitionSchema,
    surfaces: z
      .array(SurfaceDefinitionSchema)
      .max(AGENT_VERSION_SURFACES_MAX)
      .default([])
      .readonly(),
    toolBundles: z
      .array(AgentVersionToolBundleSchema)
      .max(AGENT_DEFINITION_MAX_REFERENCES)
      .readonly()
      .optional(),
    /** ADR-0133 D2: what the agent is for, shown to platforms and to a parent agent choosing it. */
    description: z.string().min(1).max(PORTABLE_AGENT_DESCRIPTION_MAX_LENGTH).optional(),
    /** ADR-0133 D14: other agents of this workspace this agent may delegate to, by name; one level. */
    subagents: z
      .array(
        z
          .object({ name: z.string().min(1).max(AGENT_NAME_MAX_LENGTH) })
          .strict()
          .readonly(),
      )
      .max(PORTABLE_AGENT_SUBAGENTS_MAX)
      .readonly()
      .optional(),
    /** ADR-0133 D2: knowledge sources. Agent Workspace honours `files` and `connector`; `url` is not accepted in a body. */
    knowledge: z
      .array(
        z.discriminatedUnion('kind', [
          z
            .object({
              kind: z.literal('files'),
              paths: z
                .array(z.string().min(1).max(AGENT_DEFINITION_FILE_PATH_MAX_LENGTH))
                .min(1)
                .max(PORTABLE_AGENT_LIST_MAX)
                .readonly(),
            })
            .strict()
            .readonly(),
          z
            .object({
              kind: z.literal('connector'),
              name: z.string().min(1).max(AGENT_NAME_MAX_LENGTH),
            })
            .strict()
            .readonly(),
        ]),
      )
      .max(PORTABLE_AGENT_LIST_MAX)
      .readonly()
      .optional(),
  })
  .strict();

type BodyShape = z.infer<typeof AgentVersionBodyShapeSchema>;

function refineSubagents(value: BodyShape, context: z.RefinementCtx): void {
  const agentName = value.definition.agent.name;
  const subagentNames = new Set<string>();
  for (const [index, subagent] of (value.subagents ?? []).entries()) {
    const isItself = subagent.name === agentName;
    if (subagentNames.has(subagent.name) || isItself) {
      context.addIssue({
        code: 'custom',
        path: ['subagents', index, 'name'],
        message: isItself
          ? 'an agent cannot be its own subagent'
          : `the subagent ${JSON.stringify(subagent.name)} is already named in this version`,
      });
    }
    subagentNames.add(subagent.name);
  }
}

function refineKnowledge(value: BodyShape, context: z.RefinementCtx): void {
  const grantedFiles = new Set(value.definition.resources.files.map((file) => file.path));
  const connectors = new Set(value.definition.resources.connectors);
  const knowledgeConnectors = new Set<string>();
  for (const [index, source] of (value.knowledge ?? []).entries()) {
    if (source.kind === 'files') {
      for (const [pathIndex, path] of source.paths.entries()) {
        if (grantedFiles.has(path)) continue;
        context.addIssue({
          code: 'custom',
          path: ['knowledge', index, 'paths', pathIndex],
          message: `the knowledge file ${JSON.stringify(path)} is not granted in resources.files`,
        });
      }
      continue;
    }
    if (knowledgeConnectors.has(source.name)) {
      context.addIssue({
        code: 'custom',
        path: ['knowledge', index],
        message: `the knowledge connector ${JSON.stringify(source.name)} is already named in this version`,
      });
    }
    knowledgeConnectors.add(source.name);
    if (!connectors.has(source.name)) {
      context.addIssue({
        code: 'custom',
        path: ['knowledge', index, 'name'],
        message: `the knowledge connector ${JSON.stringify(source.name)} is not in resources.connectors`,
      });
    }
  }
}

function refineToolBundles(value: BodyShape, context: z.RefinementCtx): void {
  const bundled = new Set<string>();
  for (const [index, bundle] of (value.toolBundles ?? []).entries()) {
    if (bundled.has(bundle.tool)) {
      context.addIssue({
        code: 'custom',
        path: ['toolBundles', index, 'tool'],
        message: `the tool ${JSON.stringify(bundle.tool)} already has a bundle in this version`,
      });
    }
    bundled.add(bundle.tool);
  }
}

function refineSurfaces(value: BodyShape, context: z.RefinementCtx): void {
  const agentName = value.definition.agent.name;
  const seen = new Set<string>();
  for (const [index, surface] of value.surfaces.entries()) {
    if (seen.has(surface.name)) {
      context.addIssue({
        code: 'custom',
        path: ['surfaces', index, 'name'],
        message: `the surface name ${JSON.stringify(surface.name)} is already used in this version`,
      });
    }
    seen.add(surface.name);
    if (surface.agent !== agentName) {
      context.addIssue({
        code: 'custom',
        path: ['surfaces', index, 'agent'],
        message: `must be ${JSON.stringify(agentName)}, the agent this version defines`,
      });
    }
  }
}

/**
 * What a version holds: the agent's portable definition and its surfaces (ADR-0101, ADR-0108;
 * issue #440). `surfaces` defaults to `[]`, so an agent with no surface saves without one.
 * `toolBundles` is absent unless the agent has code tools (issue #790), so every earlier body is
 * unchanged. `description`, `subagents` and `knowledge` (ADR-0133) are absent unless the agent sets
 * them, for the same reason.
 *
 * These rules hold across the body, each refused at the offending entry's path:
 *
 * - surface names are unique within the body (`['surfaces', i, 'name']`);
 * - every surface names this body's agent, `definition.agent.name` (`['surfaces', i, 'agent']`) —
 *   a surface naming a different agent would otherwise be saved and silently attached to this one;
 * - a tool has at most one bundle (`['toolBundles', i, 'tool']`);
 * - subagent names are unique and none is the agent itself (`['subagents', i, 'name']`);
 * - knowledge is a label on resources the agent already reaches: every `files` path is granted in
 *   `definition.resources.files` (`['knowledge', i, 'paths', j]`) and every `connector` is in
 *   `definition.resources.connectors` (`['knowledge', i, 'name']`).
 */
export const AgentVersionBodySchema = AgentVersionBodyShapeSchema.superRefine((value, context) => {
  refineSubagents(value, context);
  refineKnowledge(value, context);
  refineToolBundles(value, context);
  refineSurfaces(value, context);
}).readonly();
/** A parsed version body; `surfaces` is always present (ADR-0101; issue #440). */
export type AgentVersionBody = z.infer<typeof AgentVersionBodySchema>;
/** What {@link AgentVersionBodySchema} accepts; `surfaces` and `policySource` may be left out. */
export type AgentVersionBodyInput = z.input<typeof AgentVersionBodySchema>;

/**
 * A one-line description of what a version changed: 1–200 characters, no control (`Cc`), format
 * (`Cf`), lone surrogate (`Cs`) or line or paragraph separator (`Zl`, `Zp`) character, and no
 * whitespace at either end, so a summary of spaces alone is refused. The length check aborts
 * before the patterns run (ADR-0101; issue #440).
 */
export const AgentVersionSummarySchema = z
  .string()
  .min(1, { abort: true })
  .max(AGENT_VERSION_SUMMARY_MAX_LENGTH, { abort: true })
  .regex(
    /^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+$/u,
    'must not contain control or invisible characters',
  )
  .regex(/^(?!\s)[\s\S]*(?<!\s)$/u, 'must not start or end with whitespace');

const AGENT_VERSION_DRAFT_SHAPE = {
  body: AgentVersionBodySchema,
  summary: AgentVersionSummarySchema,
  via: ClientAgentVersionViaSchema,
};

/** A version as a client submits it: the body, a summary and how it was saved (ADR-0101; #440). */
export const AgentVersionDraftSchema = z.object(AGENT_VERSION_DRAFT_SHAPE).strict().readonly();
export type AgentVersionDraft = z.infer<typeof AgentVersionDraftSchema>;
export type AgentVersionDraftInput = z.input<typeof AgentVersionDraftSchema>;

/**
 * The body of a create-version request (S1-05). `dryRun: true` runs the whole save pipeline and
 * writes nothing (C8); `dryRun: false` is refused rather than meaning "save", so a client cannot
 * believe it asked for a dry run when it did not (ADR-0101; issue #440).
 */
export const CreateAgentVersionRequestSchema = z
  .object({ ...AGENT_VERSION_DRAFT_SHAPE, dryRun: z.literal(true).optional() })
  .strict()
  .readonly();
export type CreateAgentVersionRequest = z.infer<typeof CreateAgentVersionRequestSchema>;
export type CreateAgentVersionRequestInput = z.input<typeof CreateAgentVersionRequestSchema>;

/**
 * One saved version as it crosses the HTTP boundary — and the columns S1-04's version store keeps.
 * A version is immutable: it has a `createdAt` and no `updatedAt` (ADR-0101; issue #440).
 */
export const AgentVersionResourceSchema = z
  .object({
    id: z.string().min(1),
    agentId: z.string().min(1),
    workspaceId: z.string().min(1),
    number: AgentVersionNumberSchema,
    summary: AgentVersionSummarySchema,
    via: AgentVersionViaSchema,
    body: AgentVersionBodySchema,
    createdByPrincipalId: z.string().min(1),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();
export type AgentVersionResource = z.infer<typeof AgentVersionResourceSchema>;

/**
 * The `200` of every dry run: the body would be saved, as version `number` (ADR-0101; C8;
 * issue #440).
 */
export const AgentVersionCheckResponseSchema = z
  .object({ ok: z.literal(true), number: AgentVersionNumberSchema })
  .strict()
  .readonly();
export type AgentVersionCheckResponse = z.infer<typeof AgentVersionCheckResponseSchema>;
