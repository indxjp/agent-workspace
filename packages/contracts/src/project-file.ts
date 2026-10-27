import { z } from 'zod';

import { EngineIdSchema } from './engines.js';
import { ConnectorIdentitySchema } from './identity-assertion.js';
import { MODEL_CONNECTION_CONFIG_FIELDS, MODEL_PROVIDER_CONFIG_RULES } from './models.js';
import { ProjectPolicySchema } from './policy-ceiling.js';
import { ProjectPlatformsSchema } from './project-platforms.js';
import { MODEL_PROVIDERS } from './runs.js';
import type { RuntimeDriver } from './runtimes.js';
import { SecretReferenceSchema } from './secret-reference.js';
import { SKILL_NAME_PATTERN } from './skills.js';
import { urlCarriesCredential } from './url-credential.js';

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

/** The clouds an environment may target; `local` is the developer's own machine. */
export const PROJECT_CLOUDS = ['aws', 'gcp', 'azure', 'local'] as const;
export type ProjectCloud = (typeof PROJECT_CLOUDS)[number];

/** The port `aw dev` serves the local environment on when the file names none (ADR-0109). */
export const DEFAULT_LOCAL_PORT = 3000;

/**
 * The port the local runtime's model gateway binds before web (ADR-0109: fixed, unlike
 * `environments.local.port`). Issue #560: a project port equal to it can never start.
 */
export const LOCAL_RUNTIME_GATEWAY_PORT = 4000;

/**
 * The port the local runtime's runner binds before web (ADR-0109: fixed, unlike
 * `environments.local.port`). Issue #560: a project port equal to it can never start.
 */
export const LOCAL_RUNTIME_RUNNER_PORT = 8080;

/**
 * The ports the local runtime keeps for its own services (ADR-0109), with the service each one
 * belongs to, so a refusal can name it. `environments.local.port` may be none of them.
 */
export const LOCAL_RUNTIME_RESERVED_PORTS = [
  { port: LOCAL_RUNTIME_GATEWAY_PORT, service: 'gateway' },
  { port: LOCAL_RUNTIME_RUNNER_PORT, service: 'runner' },
] as const;
export type LocalRuntimeReservedPort = (typeof LOCAL_RUNTIME_RESERVED_PORTS)[number];
export type LocalRuntimeService = LocalRuntimeReservedPort['service'];

/** The bootstrap Owner `aw init` writes for the local environment (ADR-0103, ADR-0109). */
export const DEFAULT_BOOTSTRAP_ADMIN = 'admin@localhost.test';

/**
 * The name-key grammar: lower-case kebab, 1–64 characters, no hyphen at either end. It is the
 * skills' grammar, named for what a project, an agent or a surface uses it for — one pattern, so
 * the two can never disagree.
 */
export const NAME_KEY_PATTERN = SKILL_NAME_PATTERN;

/** The email shape the CLI's profile has always accepted for the bootstrap Owner. */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;

/** The longest bootstrap Owner address, in characters (RFC 5321's path limit, rounded up). */
export const BOOTSTRAP_ADMIN_MAX_LENGTH = 320;

/**
 * No C0 control, DEL or C1 control (U+0000–U+001F, U+007F, U+0080–U+009F): `\p{Cc}` is exactly
 * that set.
 */
const NO_CONTROL_CHARACTER_PATTERN = /^\P{Cc}*$/u;

/**
 * The bootstrap Owner's email: the one schema the project file and the local runtime's `start`
 * message share, so a project file that validates always fits a `start` message. The length check
 * aborts before the pattern runs, so an over-long value is refused without backtracking over it.
 * A value holding a C0 control, DEL or a C1 control (U+0000–U+001F, U+007F, U+0080–U+009F) is
 * refused before the email pattern runs, because a client prints this address and such a character
 * can rewrite what a terminal shows — so no client has to re-check it.
 */
export const BootstrapAdminSchema = z
  .string()
  .max(BOOTSTRAP_ADMIN_MAX_LENGTH, { abort: true })
  .regex(NO_CONTROL_CHARACTER_PATTERN, {
    message: 'must not contain a control character',
    abort: true,
  })
  .regex(EMAIL_PATTERN, 'must be an email address');

/**
 * The runtime drivers `packages/runtime` implements — the ones a project file or a `start` message
 * may name. The other ids of {@link RuntimeDriver} are catalogued but unbuilt, so naming one would
 * validate here and fail only when the runtime tried to register it; the CLI's profile schema
 * refuses the same ids. A driver joins this list in the change that implements it.
 */
export const IMPLEMENTED_RUNTIME_DRIVERS = [
  'local',
  'sandbox-runtime',
  'docker',
  'kubernetes',
  'cloud-run-service',
  'aca-sessions',
] as const satisfies readonly RuntimeDriver[];
export type ImplementedRuntimeDriver = (typeof IMPLEMENTED_RUNTIME_DRIVERS)[number];

/**
 * Where an environment keeps its data. Structural only: which managed store, object scheme and
 * secret backend a cloud may name stays in the CLI until P-2.
 */
export const ProjectStorageSchema = z
  .object({
    relational: z.string().min(1).max(1024),
    objects: z.string().min(1).max(1024),
    secrets: z.string().min(1).max(1024),
  })
  .strict()
  .readonly();
export type ProjectStorage = z.infer<typeof ProjectStorageSchema>;

/** The runtime driver an environment's agents run on unless an agent says otherwise. */
export const ProjectRuntimeSchema = z
  .object({ default: z.enum(IMPLEMENTED_RUNTIME_DRIVERS) })
  .strict()
  .readonly();
export type ProjectRuntime = z.infer<typeof ProjectRuntimeSchema>;

/** Who may first sign in: the bootstrap Owner's email and, optionally, an https OIDC issuer. */
export const ProjectIdentitySchema = z
  .object({
    bootstrapAdmin: BootstrapAdminSchema,
    oidc: z
      .url({ protocol: /^https$/u, error: 'must be an https:// issuer URL' })
      .max(2048)
      .optional(),
  })
  .strict()
  .readonly();
export type ProjectIdentity = z.infer<typeof ProjectIdentitySchema>;

/** A TCP port the environment serves on. */
export const ProjectPortSchema = z.number().int().min(1).max(65535);

/**
 * The port the `local` environment serves web on: a {@link ProjectPortSchema} that is not one of
 * {@link LOCAL_RUNTIME_RESERVED_PORTS} (ADR-0109, issue #560). A reserved port gets one issue
 * naming the service, which a reader prefixes with the field's path. The project file is shared, so
 * this follows the fixed ADR-0109 ports whatever a machine's `.env` moves the runner or gateway to;
 * the local runtime refuses the ports it will really bind, the embedded PostgreSQL's included,
 * again before it starts.
 */
export const LocalPortSchema = ProjectPortSchema.superRefine((port, context) => {
  const reserved = LOCAL_RUNTIME_RESERVED_PORTS.find((entry) => entry.port === port);
  if (reserved !== undefined) {
    context.addIssue({
      code: 'custom',
      message: `is reserved by the local runtime's ${reserved.service} (${String(reserved.port)}); choose another port`,
    });
  }
});

/** One environment of a project, any cloud: the general shape slice 2 onwards builds on. */
export const ProjectEnvironmentSchema = z
  .object({
    cloud: z.enum(PROJECT_CLOUDS),
    storage: ProjectStorageSchema.optional(),
    runtime: ProjectRuntimeSchema.optional(),
    identity: ProjectIdentitySchema,
    port: ProjectPortSchema.optional(),
  })
  .strict()
  .readonly();
export type ProjectEnvironment = z.infer<typeof ProjectEnvironmentSchema>;

/**
 * Slice 1's `local` environment: `cloud: local`, and no `storage` key at all — `aw dev` provides
 * the stores itself (ADR-0109), so a `storage` block here is refused rather than ignored.
 *
 * A per-environment `policy` is not built yet (ADR-0102 SD6, issue #524): it is refused at
 * `environments.local.policy`, and the top-level `policy` is the one ceiling.
 */
export const LocalEnvironmentSchema = z
  .object({
    cloud: z.literal('local'),
    runtime: ProjectRuntimeSchema.optional(),
    identity: ProjectIdentitySchema,
    port: LocalPortSchema.optional(),
    policy: z
      .never({
        error: 'a per-environment policy is not built yet; use the top-level policy (ADR-0102 SD6)',
      })
      .optional(),
  })
  .strict()
  .readonly();
export type LocalEnvironment = z.infer<typeof LocalEnvironmentSchema>;

/** The most entries a project file's `models` or `connectors` map may hold (issue #524). */
export const PROJECT_RESOURCE_MAP_MAX_ENTRIES = 64;

/** The longest `baseUrl` or connector `url` a project file may name, in characters. */
const PROJECT_URL_MAX_LENGTH = 2048;

/** The longest Azure `deployment` or `apiVersion` a project file may name, in characters. */
const PROJECT_CONFIG_TEXT_MAX_LENGTH = 200;

/** The fixed refusal for a credential in a URL; it never echoes the value. */
const URL_CREDENTIAL_MESSAGE =
  'must not carry a credential; name it as a secret reference { secret: NAME } (C10)';

/**
 * Refuses a URL that carries a credential ({@link urlCarriesCredential}): a user name or password,
 * or a credential query parameter. A credential is a `{ secret: NAME }` reference (C10), so a
 * committed file never holds its value. It runs only on a value the URL check accepted.
 */
function refuseUrlCredential(value: string, context: z.RefinementCtx<string>): void {
  if (!URL.canParse(value)) return;
  if (urlCarriesCredential(new URL(value))) {
    context.addIssue({ code: 'custom', message: URL_CREDENTIAL_MESSAGE });
  }
}

/**
 * An `http:` or `https:` URL, at most {@link PROJECT_URL_MAX_LENGTH} characters, with no
 * credential in it (no user name or password, and no credential query parameter).
 */
export const ProjectHttpUrlSchema = z
  .url({ protocol: /^https?$/u, error: 'must be an http:// or https:// URL', abort: true })
  .max(PROJECT_URL_MAX_LENGTH, { abort: true })
  .superRefine(refuseUrlCredential);

/**
 * The deploy recipes a non-local environment may name (issue #621): `single-vm` is the Compose
 * project on one machine, `gcp-cloudrun` the `infra/terraform/gcp-cloudrun` module, `kubernetes`
 * the `infra/helm/agent-workspace` chart installed into the cluster the kubeconfig points at,
 * `vercel` the whole agent app as Vercel projects (ADR-0120, ADR-0126).
 */
export const PROJECT_DEPLOY_TARGETS = [
  'single-vm',
  'gcp-cloudrun',
  'kubernetes',
  'vercel',
] as const;
export type ProjectDeployTarget = (typeof PROJECT_DEPLOY_TARGETS)[number];

/**
 * An `https:` origin — no path, query or fragment — at most {@link PROJECT_URL_MAX_LENGTH}
 * characters, with no credential in it: where a deployed environment is served.
 */
const ProjectOriginUrlSchema = z
  .url({ protocol: /^https$/u, error: 'must be an https:// URL', abort: true })
  .max(PROJECT_URL_MAX_LENGTH, { abort: true })
  .superRefine((value, context) => {
    if (!URL.canParse(value)) return;
    const url = new URL(value);
    if (urlCarriesCredential(url)) {
      context.addIssue({ code: 'custom', message: URL_CREDENTIAL_MESSAGE });
    } else if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      context.addIssue({
        code: 'custom',
        message:
          'must be an origin only, such as https://agents.example.com; no path, query or fragment',
      });
    }
  });

/**
 * The `production` environment (issue #621): the deploy recipe it uses and the URL it is served
 * at — nothing else. Where its data lives follows from the recipe; `aw deploy` turns it into the
 * CLI's v1 profile, which stays internal.
 */
export const ProductionEnvironmentSchema = z
  .object({
    target: z.enum(PROJECT_DEPLOY_TARGETS),
    url: ProjectOriginUrlSchema,
  })
  .strict()
  .readonly();
export type ProductionEnvironment = z.infer<typeof ProductionEnvironmentSchema>;

/** The reserved key a parser would drop from a map rather than check (see `projectResourceMap`). */
const PROTOTYPE_KEY = '__proto__';

/**
 * Refuses an own `__proto__` key. A YAML or JSON reader keeps it as an own key, but Zod's record
 * skips it without checking its name or its value, so the entry would be accepted and dropped —
 * a credential string or a `stdio` connector under it would pass unseen. It is refused here, at
 * its own path, before the record parses the map.
 */
function refusePrototypeKey(value: unknown, context: z.RefinementCtx<unknown>): void {
  if (typeof value === 'object' && value !== null && Object.hasOwn(value, PROTOTYPE_KEY)) {
    context.addIssue({
      code: 'custom',
      path: [PROTOTYPE_KEY],
      message: 'must be lower-case kebab, 1-64 characters',
    });
  }
}

/**
 * A `models` or `connectors` map: name keys in {@link NAME_KEY_PATTERN}, bounded in size. The map
 * is a pipe whose first step only refuses an own `__proto__` key (see {@link refusePrototypeKey})
 * and transforms nothing, so the editor schema is still the record's.
 */
function projectResourceMap<Value extends z.ZodType>(value: Value) {
  const map = z
    .record(z.string().regex(NAME_KEY_PATTERN, 'must be lower-case kebab, 1-64 characters'), value)
    .readonly()
    .refine(
      (entries) => Object.keys(entries).length <= PROJECT_RESOURCE_MAP_MAX_ENTRIES,
      `must hold at most ${String(PROJECT_RESOURCE_MAP_MAX_ENTRIES)} entries`,
    );
  return z.unknown().superRefine(refusePrototypeKey).pipe(map);
}

/**
 * One model connection a project file declares under `models.<name>` (C10, C11, issue #524):
 * the provider, the credential as a secret reference, and the provider's settings. Which settings
 * a provider accepts and requires is `MODEL_PROVIDER_CONFIG_RULES`, the server's own table: each
 * setting it does not accept, and each it requires that is missing, is refused at the setting's
 * own path (`models.<name>.deployment`).
 *
 * A connection carries no model id (C11), so a `model` key is refused at its path; an agent names
 * its model.
 */
export const ProjectModelConnectionSchema = z
  .object({
    provider: z.enum(MODEL_PROVIDERS),
    credential: SecretReferenceSchema,
    baseUrl: ProjectHttpUrlSchema.optional(),
    deployment: z.string().min(1).max(PROJECT_CONFIG_TEXT_MAX_LENGTH).optional(),
    apiVersion: z.string().min(1).max(PROJECT_CONFIG_TEXT_MAX_LENGTH).optional(),
    model: z
      .never({ error: 'a model connection carries no model id (C11); name the model in an agent' })
      .optional(),
  })
  .strict()
  .superRefine((connection, context) => {
    const rule = MODEL_PROVIDER_CONFIG_RULES[connection.provider];
    for (const field of MODEL_CONNECTION_CONFIG_FIELDS) {
      const present = connection[field] !== undefined;
      if (present && !rule.allowed.includes(field)) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `is not accepted for provider ${connection.provider}`,
        });
      }
      if (!present && rule.required.includes(field)) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `is required for provider ${connection.provider}`,
        });
      }
    }
  })
  .readonly();
export type ProjectModelConnection = z.infer<typeof ProjectModelConnectionSchema>;

/** The transports a project file's connector may use; an absent `transport` means `http`. */
export const PROJECT_CONNECTOR_TRANSPORTS = ['http', 'sse'] as const;
export type ProjectConnectorTransport = (typeof PROJECT_CONNECTOR_TRANSPORTS)[number];

/** The authentication schemes a project file's connector may name (issue #524). */
export const PROJECT_CONNECTOR_AUTH_SCHEMES = ['bearer', 'api-key'] as const;
export type ProjectConnectorAuthScheme = (typeof PROJECT_CONNECTOR_AUTH_SCHEMES)[number];

/**
 * One MCP connector a project file declares under `connectors.<name>` (C10, issue #524): its
 * `http(s)` URL, its transport, and optionally its credential as a secret reference. An absent
 * `transport` means `http`; the schema records that in this comment rather than transforming the
 * value, so the editor schema stays exact. A `stdio` connector is refused: a project file names
 * only remote connectors.
 */
export const ProjectConnectorSchema = z
  .object({
    url: ProjectHttpUrlSchema,
    transport: z
      .enum(PROJECT_CONNECTOR_TRANSPORTS, {
        error: 'must be http or sse; a stdio connector is not supported in a project file',
      })
      .optional(),
    auth: z
      .object({
        scheme: z.enum(PROJECT_CONNECTOR_AUTH_SCHEMES),
        credential: SecretReferenceSchema,
      })
      .strict()
      .readonly()
      .optional(),
    /** Opt in to the signed identity assertion (ADR-0142 D1); the server reads the named secret at run compose. */
    identity: ConnectorIdentitySchema.optional(),
  })
  .strict()
  .readonly();
export type ProjectConnector = z.infer<typeof ProjectConnectorSchema>;

/**
 * A v2 project file: the `local` environment and, optionally, `production` (issue #621: a deploy
 * `target` and a `url`). Any other key — at the root, under `environments` (`preview`), in `local`
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
