import { z } from 'zod';

import { EngineIdSchema } from './engines.js';
import { FeatureListSchema } from './features.js';
import {
  LocalEnvironmentSchema,
  PROJECT_CLOUDS,
  ProjectIdentitySchema,
  ProjectRuntimeSchema,
  ProjectStorageSchema,
  type ProjectEnvironment,
} from './project-file-environments.js';
import { ProductionEnvironmentSchema } from './project-file-deploy.js';
import { ProjectConnectorSchema, ProjectModelConnectionSchema } from './project-file-resources.js';
import { NAME_KEY_PATTERN, projectResourceMap } from './project-file-shared.js';
import { ProjectPolicySchema } from './policy-ceiling.js';
import { ProjectPlatformsSchema } from './project-platforms.js';

/** The one URL-credential rule; a server that builds a project from stored URLs applies it too. */
export { urlCarriesCredential } from './url-credential.js';

export {
  PlatformOptionsSchema,
  ProjectPlatformBindingSchema,
  ProjectPlatformsSchema,
  type PlatformOptions,
  type ProjectPlatformBinding,
  type ProjectPlatforms,
} from './project-platforms.js';

export * from './project-file-environments.js';
export * from './project-file-deploy.js';
export * from './project-file-resources.js';
export {
  NAME_KEY_PATTERN,
  PROJECT_RESOURCE_MAP_MAX_ENTRIES,
  ProjectHttpUrlSchema,
} from './project-file-shared.js';

/**
 * Issue #439 (S1-01): `agent-workspace.yaml` as a project file — the `Project` kind of ADR-0103,
 * which `aw init` writes, `aw dev` reads and the CLI's `Deployment` profile (v1) is lifted into.
 *
 * Issue #524 (S2-01a) adds the project's `engine`, `models` (model connections), `connectors` and
 * `policy` (the ceiling, ADR-0102 SD6). A credential is always a secret reference
 * `{ secret: NAME }`, never a value (C10).
 *
 * Every schema here is plain structure: no preprocess and no transform, so `z.toJSONSchema` can
 * emit the editor schema from the same definitions (ADR-0103's consequence). A local file is not a
 * route, so nothing here crosses the HTTP API.
 */
export const PROJECT_API_VERSION = 'agentworkspace.dev/v2';

/** The one kind of document a v2 project file holds. */
export const PROJECT_KIND = 'Project';

/** The CLI's earlier profile format, still read and lifted (its grace period ends at 0.3.0). */
export const DEPLOYMENT_V1_API_VERSION = 'agentworkspace.dev/v1';

/** The one kind of document a v1 profile holds. */
export const DEPLOYMENT_V1_KIND = 'Deployment';

/**
 * A v2 project file: the `local` environment and, optionally, `production` (issue #621: a deploy
 * `target`, a `url` and, since issue #1512, optional `apps`, and `gcp` for the `gcp-cloudrun`
 * target). Any other key — at the root, under `environments` (`preview`), in `local`
 * (`storage`) or in `production` (`cloud`) — is refused by a strict object, which reports
 * `unrecognized_keys` at the parent's path.
 *
 * Issue #524 (S2-01a) adds four optional root keys, each absent in every slice-1 file:
 *
 * - `engine` — the engine an agent that names none runs on (C12);
 * - `models` — the model connections `aw dev` keeps in step, by name (C11);
 * - `connectors` — the MCP connectors `aw dev` keeps in step, by name (C10);
 * - `policy` — the deployment's policy ceiling (ADR-0102 SD6, C13).
 *
 * Until the units that apply them land, these keys parse and `aw dev` does not act on them yet.
 *
 * Programme Platform targets adds `platforms` — the agent platforms the project exports or
 * publishes to, with their options (brief D7, ADR-0133). `aw dev` ignores it; `aw platforms`
 * reads it.
 */
export const ProjectDocumentSchema = z
  .object({
    apiVersion: z.literal(PROJECT_API_VERSION),
    kind: z.literal(PROJECT_KIND),
    name: z.string().regex(NAME_KEY_PATTERN, 'must be lower-case kebab, 1-64 characters'),
    engine: EngineIdSchema.optional(),
    models: projectResourceMap(ProjectModelConnectionSchema).optional(),
    connectors: projectResourceMap(ProjectConnectorSchema).optional(),
    policy: ProjectPolicySchema.optional(),
    platforms: ProjectPlatformsSchema.optional(),
    /** The features this deployment installs; absent means every feature (ADR-0160 D5). */
    features: FeatureListSchema.optional(),
    environments: z
      .strictObject({
        local: LocalEnvironmentSchema,
        production: ProductionEnvironmentSchema.optional(),
      })
      .readonly(),
  })
  .strict()
  .readonly();
export type ProjectDocument = z.infer<typeof ProjectDocumentSchema>;

/**
 * A v1 `Deployment` profile, structurally: the envelope is optional (as the CLI's grace period
 * allows) and all four fields are required. It is not the CLI's profile schema and does not agree
 * with it in two directions:
 *
 * - The CLI trims every text field before checking it; this schema has no transform, so a value
 *   with whitespace at either end — only a quoted, padded YAML scalar can carry one — is refused
 *   here although `agent-workspace validate` accepts it.
 * - The per-cloud rules (which managed store, object scheme and secret backend a cloud may name)
 *   live in `packages/cli`'s profile schema until P-2, so a store the CLI refuses for its cloud is
 *   accepted here.
 *
 * The envelope rule (`kind` is required once `apiVersion` is set) and the implemented runtime
 * drivers are enforced here as in the CLI.
 */
export const DeploymentDocumentV1Schema = z
  .object({
    apiVersion: z.literal(DEPLOYMENT_V1_API_VERSION).optional(),
    kind: z.literal(DEPLOYMENT_V1_KIND).optional(),
    cloud: z.enum(PROJECT_CLOUDS),
    storage: ProjectStorageSchema,
    runtime: ProjectRuntimeSchema,
    identity: ProjectIdentitySchema,
  })
  .strict()
  .readonly();
export type DeploymentDocumentV1 = z.infer<typeof DeploymentDocumentV1Schema>;

/**
 * A v1 profile lifted into the project shape: one environment, `local` for `cloud: local` (with
 * its storage kept, so `aw dev` can refuse a Compose store it does not provide) and `production`
 * for every other cloud. It has no `name`, because a v1 profile has none.
 */
export interface LiftedProjectDocument {
  readonly apiVersion: typeof PROJECT_API_VERSION;
  readonly kind: typeof PROJECT_KIND;
  readonly environments:
    | { readonly local: ProjectEnvironment; readonly production?: never }
    | { readonly production: ProjectEnvironment; readonly local?: never };
}

/** What {@link readProjectDocument} read: a v2 document as written, or a lifted v1 profile. */
export type ProjectRead =
  | { readonly lifted: false; readonly project: ProjectDocument }
  | { readonly lifted: true; readonly project: LiftedProjectDocument };

/** The result of {@link readProjectDocument}; it never throws. */
export type ProjectReadResult =
  | { readonly success: true; readonly data: ProjectRead }
  | { readonly success: false; readonly error: z.ZodError };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refusal(path: 'apiVersion' | 'kind', message: string, input: unknown): ProjectReadResult {
  return {
    success: false,
    error: new z.ZodError([{ code: 'custom', path: [path], message, input }]),
  };
}

/** Lifts a parsed v1 profile; the result is frozen throughout, as a parsed v2 document is. */
function liftDeployment(deployment: DeploymentDocumentV1): LiftedProjectDocument {
  const environment: ProjectEnvironment = Object.freeze({
    cloud: deployment.cloud,
    storage: deployment.storage,
    runtime: deployment.runtime,
    identity: deployment.identity,
  });
  return Object.freeze({
    apiVersion: PROJECT_API_VERSION,
    kind: PROJECT_KIND,
    environments: Object.freeze(
      deployment.cloud === 'local' ? { local: environment } : { production: environment },
    ),
  });
}

/**
 * Reads a parsed `agent-workspace.yaml` (the YAML already turned into a value). The envelope
 * decides the schema: `agentworkspace.dev/v2` or `kind: Project` is a project file; `v1` or no
 * envelope at all is a `Deployment` profile, lifted with `lifted: true`. Any other `apiVersion`
 * is refused at `apiVersion`; a kind that contradicts its version, or a `v1` with no kind (as the
 * CLI refuses it), at `kind`. Every result is frozen.
 */
export function readProjectDocument(value: unknown): ProjectReadResult {
  const apiVersion = isRecord(value) ? value['apiVersion'] : undefined;
  const kind = isRecord(value) ? value['kind'] : undefined;

  if (
    apiVersion !== undefined &&
    apiVersion !== PROJECT_API_VERSION &&
    apiVersion !== DEPLOYMENT_V1_API_VERSION
  ) {
    return refusal(
      'apiVersion',
      `must be ${PROJECT_API_VERSION} or ${DEPLOYMENT_V1_API_VERSION}`,
      apiVersion,
    );
  }
  if (apiVersion === DEPLOYMENT_V1_API_VERSION && kind === undefined) {
    return refusal('kind', `is required; write kind: ${DEPLOYMENT_V1_KIND}`, kind);
  }
  if (apiVersion === DEPLOYMENT_V1_API_VERSION && kind === PROJECT_KIND) {
    return refusal('kind', `must be ${DEPLOYMENT_V1_KIND} for ${DEPLOYMENT_V1_API_VERSION}`, kind);
  }
  if (apiVersion === PROJECT_API_VERSION && kind === DEPLOYMENT_V1_KIND) {
    return refusal('kind', `must be ${PROJECT_KIND} for ${PROJECT_API_VERSION}`, kind);
  }

  if (apiVersion === PROJECT_API_VERSION || kind === PROJECT_KIND || !isRecord(value)) {
    const parsed = ProjectDocumentSchema.safeParse(value);
    return parsed.success
      ? { success: true, data: { lifted: false, project: parsed.data } }
      : { success: false, error: parsed.error };
  }

  const parsed = DeploymentDocumentV1Schema.safeParse(value);
  return parsed.success
    ? { success: true, data: { lifted: true, project: liftDeployment(parsed.data) } }
    : { success: false, error: parsed.error };
}
