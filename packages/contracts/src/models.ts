import { z } from 'zod';

import { IsoDateTimeSchema } from './identifiers.js';
import { MODEL_PROVIDERS, type ModelProvider } from './runs.js';

/** The non-credential settings a model connection can carry; which ones apply is per provider. */
export const MODEL_CONNECTION_CONFIG_FIELDS = [
  'baseUrl',
  'deployment',
  'apiVersion',
  'projectId',
  'location',
] as const;
export type ModelConnectionConfigField = (typeof MODEL_CONNECTION_CONFIG_FIELDS)[number];

export interface ModelProviderConfigRule {
  /** The config keys the server accepts for this provider; any other key is an `invalid_body`. */
  readonly allowed: readonly ModelConnectionConfigField[];
  /** The subset that must be present for the connection to be `ready` (with a credential). */
  readonly required: readonly ModelConnectionConfigField[];
  /**
   * How the connection authenticates: `api-key` stores a write-only credential; `workload-identity`
   * stores none and the gateway uses the identity it runs as.
   */
  readonly credential: 'api-key' | 'workload-identity';
}

/** The Vertex AI locations a `vertex` connection (and `gcp.modelLocation`) can name; absent means `global`. */
export const VERTEX_LOCATIONS = ['global', 'us', 'eu'] as const;
export type VertexLocation = (typeof VERTEX_LOCATIONS)[number];

/**
 * The Claude models served on Vertex AI, newest first. The single source for the gateway's static
 * model list, the CLI preflight probe and web setup's seeded model.
 */
export const VERTEX_CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' },
] as const;

/** The model a freshly set-up `vertex` connection is seeded with. */
export const VERTEX_DEFAULT_MODEL = 'claude-sonnet-5-5';

/** A Google Cloud project id: 6 to 30 characters, lowercase letters, digits and hyphens. */
export const GCP_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;

/**
 * Per-provider config rules, exactly as `POST`/`PATCH /api/model-connections` enforce them:
 * `anthropic`, `anthropic-compatible` and `openai` take an optional `baseUrl`;
 * `openai-compatible` requires one; `azure-openai` requires `baseUrl`, `apiVersion` and
 * `deployment`; `vertex` is keyless (`workload-identity`) and requires `projectId`, with an
 * optional `location`. A `baseUrl` must be an absolute URL the workspace's egress policy allows.
 */
export const MODEL_PROVIDER_CONFIG_RULES: Readonly<Record<ModelProvider, ModelProviderConfigRule>> =
  {
    anthropic: { allowed: ['baseUrl'], required: [], credential: 'api-key' },
    'anthropic-compatible': { allowed: ['baseUrl'], required: [], credential: 'api-key' },
    openai: { allowed: ['baseUrl'], required: [], credential: 'api-key' },
    'openai-compatible': { allowed: ['baseUrl'], required: ['baseUrl'], credential: 'api-key' },
    'azure-openai': {
      allowed: ['baseUrl', 'apiVersion', 'deployment'],
      required: ['baseUrl', 'apiVersion', 'deployment'],
      credential: 'api-key',
    },
    vertex: {
      allowed: ['projectId', 'location'],
      required: ['projectId'],
      credential: 'workload-identity',
    },
  };

/** True when the provider stores no credential and authenticates with the workload identity. */
export function isKeylessProvider(provider: ModelProvider): boolean {
  return MODEL_PROVIDER_CONFIG_RULES[provider].credential === 'workload-identity';
}

/**
 * The reserved model-id prefix of a scripted model: a test tool that replays a file of turns
 * instead of calling a provider. It is served by the gateway only when the process opted in with
 * `AW_SCRIPTED_MODELS_DIR` in the `local` deployment posture, and only on an Anthropic-family
 * connection. Never use it in a production agent.
 */
export const SCRIPTED_MODEL_PREFIX = 'scripted:';

/** What follows {@link SCRIPTED_MODEL_PREFIX}: the script's file name without `.json`. */
export const SCRIPTED_MODEL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** One scripted tool call. */
export const ScriptedToolUseSchema = z
  .object({ name: z.string().min(1), input: z.record(z.string(), z.unknown()) })
  .strict()
  .readonly();

/**
 * One scripted assistant turn: text, tool calls, or both (text first). A turn with tool calls ends
 * with `stop_reason: tool_use`, any other turn with `end_turn`.
 */
export const ScriptedModelTurnSchema = z
  .object({
    text: z.string().min(1).optional(),
    toolUses: z.array(ScriptedToolUseSchema).min(1).readonly().optional(),
  })
  .strict()
  .refine((turn) => turn.text !== undefined || turn.toolUses !== undefined, {
    message: 'A scripted turn needs "text" or "toolUses".',
  })
  .readonly();

/**
 * The file `<AW_SCRIPTED_MODELS_DIR>/<name>.json` a scripted model replays. The turn to answer with
 * is the number of assistant messages already in the conversation, so a tool call followed by its
 * result advances to the next turn.
 */
export const ScriptedModelScriptSchema = z
  .object({ turns: z.array(ScriptedModelTurnSchema).min(1).readonly() })
  .strict()
  .readonly();

export type ScriptedModelScript = z.infer<typeof ScriptedModelScriptSchema>;

/** A connection's stored settings as every response renders them. Never the credential. */
export const ModelConnectionConfigSchema = z
  .object({
    baseUrl: z.url().optional(),
    deployment: z.string().min(1).optional(),
    apiVersion: z.string().min(1).optional(),
    projectId: z.string().regex(GCP_PROJECT_ID_PATTERN).optional(),
    location: z.enum(VERTEX_LOCATIONS).optional(),
  })
  .strict()
  .readonly();

export type ModelConnectionConfig = z.infer<typeof ModelConnectionConfigSchema>;

/**
 * One model connection as `GET /api/model-connections/:id`, the `201` of
 * `POST /api/model-connections`, the `200` of `PATCH …/:id`, and every list item render it —
 * a bare item, not wrapped.
 *
 * The credential is write-only and has no field here. `hasCredential` says whether one is
 * stored; `ready` is derived on every read as every config field the provider requires
 * ({@link MODEL_PROVIDER_CONFIG_RULES}) being present AND (`hasCredential` OR the provider's rule
 * has `credential: 'workload-identity'`).
 */
export const ModelConnectionResourceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    provider: z.enum(MODEL_PROVIDERS),
    config: ModelConnectionConfigSchema,
    hasCredential: z.boolean(),
    ready: z.boolean(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();

export type ModelConnectionResource = z.infer<typeof ModelConnectionResourceSchema>;

/**
 * The body of `GET /api/model-connections`. The route names its list `models` although the
 * items are connections (a discovered model is a `GET /api/models` row); the SDK returns the
 * array so a caller never meets the key.
 */
export const ModelConnectionListResponseSchema = z
  .object({ models: z.array(ModelConnectionResourceSchema).readonly() })
  .strict()
  .readonly();

export type ModelConnectionListResponse = z.infer<typeof ModelConnectionListResponseSchema>;

/**
 * The `200` body of `DELETE /api/model-connections/:id`. The connection is gone; every agent
 * that pointed at it is named, because their reference was cleared by the same transaction and
 * they now fall back to the workspace default.
 */
export const DeleteModelConnectionResponseSchema = z
  .object({
    deleted: z.literal(true),
    referencedBy: z
      .array(
        z
          .object({
            agentId: z.string().min(1),
            agentName: z.string(),
          })
          .strict()
          .readonly(),
      )
      .readonly(),
  })
  .strict()
  .readonly();

export type DeleteModelConnectionResponse = z.infer<typeof DeleteModelConnectionResponseSchema>;

const TestOutcomeFields = {
  /** Round trip to the provider's catalog endpoint, in milliseconds, whether or not it answered. */
  latencyMs: z.number().int().nonnegative(),
  /** Safe prose chosen by the server; never the provider's own error text. */
  message: z.string().min(1),
};

/**
 * The body of `POST /api/model-connections/:id/test`, under `200` when `ok` and `502` when not.
 * The `502` carries this outcome, not the error envelope: an unreachable provider answers with
 * `status: null`, a provider that answered a non-2xx with that status.
 */
export const ModelConnectionTestOutcomeSchema = z.discriminatedUnion('ok', [
  z
    .object({ ok: z.literal(true), status: z.number().int(), ...TestOutcomeFields })
    .strict()
    .readonly(),
  z
    .object({ ok: z.literal(false), status: z.number().int().nullable(), ...TestOutcomeFields })
    .strict()
    .readonly(),
]);

export type ModelConnectionTestOutcome = z.infer<typeof ModelConnectionTestOutcomeSchema>;

/** The capability flags every discovered model reports, in the specification's order. */
export const DISCOVERED_MODEL_CAPABILITY_KEYS = [
  'streaming',
  'toolUse',
  'thinking',
  'promptCaching',
  'structuredOutput',
  'contextManagement',
  'webSearch',
  'tokenCounting',
] as const;

export const DiscoveredModelCapabilitiesSchema = z
  .object({
    streaming: z.boolean(),
    toolUse: z.boolean(),
    thinking: z.boolean(),
    promptCaching: z.boolean(),
    structuredOutput: z.boolean(),
    contextManagement: z.boolean(),
    webSearch: z.boolean(),
    tokenCounting: z.boolean(),
  })
  .strict()
  .readonly();

export type DiscoveredModelCapabilities = z.infer<typeof DiscoveredModelCapabilitiesSchema>;

/**
 * One row of `GET /api/models`: a provider-side model one ready connection offers. Model choice
 * anywhere in the platform is the pair `(connectionId, providerModelId)`, never one alone.
 */
export const DiscoveredModelSchema = z
  .object({
    connectionId: z.string().min(1),
    providerModelId: z.string().min(1),
    /** The provider's own label, passed through; a provider may leave it empty. */
    displayName: z.string(),
    capabilities: DiscoveredModelCapabilitiesSchema,
  })
  .strict()
  .readonly();

export type DiscoveredModel = z.infer<typeof DiscoveredModelSchema>;

/** Why a connection's discovery call failed; only `credential-rejected` is about the key. */
export const UNAVAILABLE_MODEL_CONNECTION_KINDS = [
  'credential-rejected',
  'provider-error',
  'connection-failed',
  'unreachable',
  'unsupported-provider',
] as const;

/** A ready connection whose discovery call failed, named rather than silently dropped. */
export const UnavailableModelConnectionSchema = z
  .object({
    connectionId: z.string().min(1),
    connectionName: z.string().min(1),
    reason: z.string().min(1),
    /** Absent from a server older than #690; a caller then treats the failure as unclassified. */
    kind: z.enum(UNAVAILABLE_MODEL_CONNECTION_KINDS).optional(),
    /** The provider's HTTP status when it answered (`credential-rejected`, `provider-error`). */
    status: z.number().int().optional(),
  })
  .strict()
  .readonly();

export type UnavailableModelConnection = z.infer<typeof UnavailableModelConnectionSchema>;

/**
 * The body of `GET /api/models`. Only ready connections are discovered; an unready one is
 * skipped without a trace. `unavailable` is present only when at least one discovery failed.
 */
export const DiscoveredModelsResponseSchema = z
  .object({
    models: z.array(DiscoveredModelSchema).readonly(),
    unavailable: z.array(UnavailableModelConnectionSchema).readonly().optional(),
  })
  .strict()
  .readonly();

export type DiscoveredModelsResponse = z.infer<typeof DiscoveredModelsResponseSchema>;

/** The `config` a caller sends; the server checks it against {@link MODEL_PROVIDER_CONFIG_RULES}. */
export interface ModelConnectionConfigInput {
  readonly baseUrl?: string;
  readonly deployment?: string;
  readonly apiVersion?: string;
  /** `vertex` only: the Google Cloud project id. */
  readonly projectId?: string;
  /** `vertex` only: a {@link VertexLocation}; absent means `global`. */
  readonly location?: VertexLocation;
}

/**
 * The body of `POST /api/model-connections`. `apiKey` is the provider credential, written once
 * here and afterwards only through {@link RotateModelConnectionCredentialInput}; it never comes
 * back. It is required for an `api-key` provider and refused for a `workload-identity` one
 * (`vertex`). `config` may be omitted for a provider that requires nothing.
 */
export interface CreateModelConnectionInput {
  readonly name: string;
  readonly provider: ModelProvider;
  readonly apiKey?: string;
  readonly config?: ModelConnectionConfigInput;
}

/**
 * The body of `PATCH /api/model-connections/:id`; omitted fields remain unchanged. The provider
 * is immutable. `apiKey` replaces the saved key. A `config.baseUrl` that changes on a connection
 * with a saved key needs a new `apiKey` in the same body, or it is
 * `409 credential_required_on_retarget` and nothing changes — the saved key never follows the
 * connection to a new destination (ADR-0077 D5).
 */
export interface UpdateModelConnectionPatch {
  readonly name?: string;
  readonly config?: ModelConnectionConfigInput;
  readonly apiKey?: string;
}

/** The body of `POST /api/model-connections/:id/credential`; the answer is an empty `204`. */
export interface RotateModelConnectionCredentialInput {
  readonly apiKey: string;
}
