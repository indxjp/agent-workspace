/**
 * The Agent Store deployment's operator routes (internal spec, "The GCP deployment", phase P6):
 * the words the deploy workflow, the nightly sample check and the daily production test share with
 * the platform. Every route here is called by the deployment's own operator steps with
 * `Authorization: Bearer <AW_DEMO_OPERATOR_TOKEN>`, never by a visitor; while the setting is unset
 * each answers `404`. A module of its own because a seed carries a K-1 agent definition, and
 * `./demo` is imported by `./runs`, which the definition's imports reach.
 */
import { z } from 'zod';

import { AgentDefinitionSchema } from './agents/definition.js';
import { DemoEntrySlugSchema } from './demo.js';
import { UuidSchema } from './identifiers.js';
import { NAME_KEY_PATTERN } from './project-file.js';
import { isBuiltinSkillName, SKILL_MD_FILENAME, SKILL_NAME_PATTERN } from './skills.js';
import { ToolOperationNameSchema } from './tool-connectors.js';

/**
 * The bearer token the deployment's own operator steps (the deploy workflow's template seeding,
 * the nightly sample check, the daily production test's maintenance flip and the readiness check)
 * send to the platform: `Authorization: Bearer <token>`. The web service reads it from this
 * setting, which a person stores in Secret Manager; while it is unset every operator route answers
 * `404`, so a deployment without it has no operator surface at all (the `CRON_SECRET` pattern).
 */
export const DEMO_OPERATOR_TOKEN_SETTING = 'AW_DEMO_OPERATOR_TOKEN';

/** The most bytes one sample file of a seed carries, decoded (the provisioner's own copy limit). */
export const DEMO_SEED_FILE_MAX_BYTES = 1_048_576;
/**
 * The folder a template workspace keeps its own files in (the sample record sets and the seed's
 * digest). A seed's sample file may not be at or under it.
 */
export const DEMO_TEMPLATE_RESERVED_FOLDER = 'demo-template';
/** The most sample files one seed carries. */
export const DEMO_SEED_FILES_MAX = 200;
/** The most sample record sets one seed carries. */
export const DEMO_SEED_RECORD_SETS_MAX = 64;
/** The most characters one record set's data has, as JSON. */
export const DEMO_SEED_RECORDS_MAX_CHARACTERS = 262_144;
/** The most connectors one seed declares. */
export const DEMO_SEED_CONNECTORS_MAX = 16;
/** The most skills one seed carries. */
export const DEMO_SEED_SKILLS_MAX = 16;
/** The most files one carried skill has. */
export const DEMO_SEED_SKILL_FILES_MAX = 64;

/** The length of `data` as JSON, or infinity when it is not JSON (`undefined`, a function, a cycle). */
function jsonLength(data: unknown): number {
  try {
    const text = JSON.stringify(data) as string | undefined;
    return text === undefined ? Number.POSITIVE_INFINITY : text.length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

const SeedNameSchema = z
  .string()
  .regex(NAME_KEY_PATTERN, 'must be lower-case kebab, 1-64 characters');

/**
 * A resource's name as a source gives it: an app resource is snake case (`kb_article`), a fixture
 * file's name is kebab or camel case. It names a file of the template, so it holds no path character.
 */
const SeedResourceSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u, 'must be a resource name: letters, digits, _ and -');

/**
 * One connector the demo agent names, as the seed declares it: the tools that only read and the
 * tools that would send or write outside. The template keeps no address and no secret of it. In a
 * visitor's copy a read tool answers from the entry's sample records ({@link DemoSampleRecordsSchema})
 * and a write tool answers `DEMO_SEND_RESULT` (`./demo`).
 */
export const DemoSeedConnectorSchema = z
  .strictObject({
    name: SeedNameSchema,
    reads: z.array(ToolOperationNameSchema).max(64).readonly(),
    writes: z.array(ToolOperationNameSchema).max(64).readonly(),
  })
  .readonly();
export type DemoSeedConnector = z.infer<typeof DemoSeedConnectorSchema>;

/** A relative path with no empty or `..` segment. */
const RelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (path) =>
      !path.startsWith('/') && !path.split('/').some((part) => part === '..' || part === ''),
    'must be a relative path with no empty or ".." segment',
  );

/** A file's bytes as base64, at most {@link DEMO_SEED_FILE_MAX_BYTES} decoded. */
const SeedBytesSchema = z.base64().max(Math.ceil(DEMO_SEED_FILE_MAX_BYTES / 3) * 4);

/**
 * One skill the demo agent is assigned, carried by its files (`SKILL.md` and the files beside it,
 * at their paths inside the skill's folder), from the entry's own source project. A built-in skill
 * (`BUILTIN_SKILL_NAMES`) is never carried: the definition names it and the platform installs its
 * own release. The template keeps the skill under its name, and a visitor's copy gets it.
 */
export const DemoSeedSkillSchema = z
  .strictObject({
    name: z
      .string()
      .regex(SKILL_NAME_PATTERN, 'must be a skill name')
      .refine((name) => !isBuiltinSkillName(name), 'a built-in skill is named, never carried'),
    files: z
      .array(z.strictObject({ path: RelativePathSchema, base64: SeedBytesSchema }).readonly())
      .min(1)
      .max(DEMO_SEED_SKILL_FILES_MAX)
      .refine(
        (files) => files.some((file) => file.path === SKILL_MD_FILENAME),
        `must hold ${SKILL_MD_FILENAME}`,
      )
      .readonly(),
  })
  .readonly();
export type DemoSeedSkill = z.infer<typeof DemoSeedSkillSchema>;

/** One sample file of the entry's `demo.seed`, at its workspace path, its bytes as base64. */
export const DemoSeedFileSchema = z
  .strictObject({
    path: RelativePathSchema.refine(
      (path) =>
        path !== DEMO_TEMPLATE_RESERVED_FOLDER &&
        !path.startsWith(`${DEMO_TEMPLATE_RESERVED_FOLDER}/`),
      `must not be at or under the reserved folder ${DEMO_TEMPLATE_RESERVED_FOLDER}`,
    ),
    base64: SeedBytesSchema,
  })
  .readonly();
export type DemoSeedFile = z.infer<typeof DemoSeedFileSchema>;

/**
 * One set of the entry's sample records (`demo.records`): the records of one resource in one
 * language, in the source's own data format, and the read tools of one seeded connector that
 * answer with them. Fictional data only.
 */
export const DemoSampleRecordsSchema = z
  .strictObject({
    connector: SeedNameSchema,
    resource: SeedResourceSchema,
    lang: z.enum(['ja', 'en']),
    tools: z.array(ToolOperationNameSchema).min(1).max(16).readonly(),
    /** The records as parsed JSON (an array of records, or one object of them). */
    data: z
      .unknown()
      .refine(
        (data) => jsonLength(data) <= DEMO_SEED_RECORDS_MAX_CHARACTERS,
        `must be JSON of at most ${String(DEMO_SEED_RECORDS_MAX_CHARACTERS)} characters`,
      ),
  })
  .readonly();
export type DemoSampleRecords = z.infer<typeof DemoSampleRecordsSchema>;

/**
 * `PUT /api/demo/templates/{entry}` (operator): fill the entry's template workspace
 * (`demoTemplateWorkspaceSlug(entry)`), making it first with the deployment's template-owner
 * account as its only member. Idempotent: the same seed twice changes nothing, and a changed seed
 * replaces the agent, its skills, its connectors, the files and the records it names. The agent is a
 * K-1 definition (`aw agents export` shape): no secret, no model connection, no runtime profile.
 * `skills` carries the files of every skill the definition names that is not a built-in.
 */
export const DEMO_TEMPLATES_PATH = '/api/demo/templates';
export const DemoTemplateSeedSchema = z
  .strictObject({
    definition: AgentDefinitionSchema,
    connectors: z.array(DemoSeedConnectorSchema).max(DEMO_SEED_CONNECTORS_MAX).readonly(),
    skills: z.array(DemoSeedSkillSchema).max(DEMO_SEED_SKILLS_MAX).readonly(),
    files: z.array(DemoSeedFileSchema).max(DEMO_SEED_FILES_MAX).readonly(),
    records: z.array(DemoSampleRecordsSchema).max(DEMO_SEED_RECORD_SETS_MAX).readonly(),
  })
  .readonly();
export type DemoTemplateSeed = z.infer<typeof DemoTemplateSeedSchema>;

/**
 * One template as `GET /api/demo/templates` (operator) reports it, for the nightly sample check:
 * whether the deployment made it, and what a visitor's copy would get from it.
 */
export const DemoTemplateReportSchema = z
  .strictObject({
    entry: DemoEntrySlugSchema,
    agent: z.string().min(1).max(200).nullable(),
    files: z.number().int().min(0),
    recordSets: z.number().int().min(0),
  })
  .readonly();
export type DemoTemplateReport = z.infer<typeof DemoTemplateReportSchema>;
export const DemoTemplateReportsSchema = z
  .strictObject({ templates: z.array(DemoTemplateReportSchema).readonly() })
  .readonly();
export type DemoTemplateReports = z.infer<typeof DemoTemplateReportsSchema>;

/**
 * `PUT /api/demo/verification/{workspaceId}` (operator, no body): copy every demo template the
 * deployment holds into the ordinary workspace `workspaceId`, made exactly as a visitor's demo copy
 * is made, for the real-model verification (R1) and the daily production test. `entries` are the
 * entries copied. Idempotent. A visitor's demo workspace, a template and a workspace with no Owner
 * are refused (`409 verification_workspace_refused`).
 */
export const DEMO_VERIFICATION_PATH = '/api/demo/verification';
export const DemoVerificationFillSchema = z
  .strictObject({
    workspaceId: UuidSchema,
    entries: z.array(DemoEntrySlugSchema).readonly(),
  })
  .readonly();
export type DemoVerificationFill = z.infer<typeof DemoVerificationFillSchema>;

/**
 * `PUT /api/demo/maintenance/{entry}` (operator): the daily production test's verdict on one live
 * entry. `maintenance` puts its card "Under maintenance" and its Try tab on the recording;
 * `available` takes it back. `reason` says why in words, never a secret or a model's raw output.
 */
export const DEMO_MAINTENANCE_PATH = '/api/demo/maintenance';
export const DEMO_ENTRY_STATES = ['available', 'maintenance'] as const;
export const DemoEntryStateSchema = z.enum(DEMO_ENTRY_STATES);
export type DemoEntryState = z.infer<typeof DemoEntryStateSchema>;
export const DemoMaintenanceRequestSchema = z
  .strictObject({
    state: DemoEntryStateSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .readonly();
export type DemoMaintenanceRequest = z.infer<typeof DemoMaintenanceRequestSchema>;

/**
 * `GET /api/demo/readiness` (operator): the read-only checks a deploy runs before it calls the
 * store ready (R2): whether the demo's Anthropic API key is configured, and whether the platform
 * reached the Anthropic API with it by listing models (no tokens are spent). It never carries the
 * key or any part of it.
 */
export const DEMO_READINESS_PATH = '/api/demo/readiness';
export const DemoReadinessSchema = z
  .strictObject({
    apiKeyConfigured: z.boolean(),
    apiReachable: z.boolean(),
  })
  .readonly();
export type DemoReadiness = z.infer<typeof DemoReadinessSchema>;
