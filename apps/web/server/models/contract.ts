import { checkEgress, loadEgressPolicyFromEnv } from '@agent-workspace/core';
import {
  GCP_PROJECT_ID_PATTERN,
  MODEL_CONNECTION_CONFIG_FIELDS,
  MODEL_PROVIDER_CONFIG_RULES,
  VERTEX_LOCATIONS,
  isKeylessProvider,
  type ModelConnectionConfigField,
  type VertexLocation,
} from '@indx-workspace/contracts/models';
import { MODEL_PROVIDERS, type ModelProvider } from '@indx-workspace/contracts/runs';

// The fields are typed `T | undefined`, not the shorthand `T`, because a repository record's
// `config` must stay assignable to this structural type: under `exactOptionalPropertyTypes` a Zod
// `.optional()` field is inferred as `T | undefined`, not merely omittable.
export type ModelConnectionConfigInput = {
  readonly baseUrl?: string | undefined;
  readonly deployment?: string | undefined;
  readonly apiVersion?: string | undefined;
  readonly projectId?: string | undefined;
  readonly location?: VertexLocation | undefined;
};

const KEYLESS_API_KEY_MESSAGE =
  "apiKey is not used: vertex uses this install's Google Cloud identity.";

export type CreateModelConnectionInput = {
  readonly name: string;
  readonly provider: ModelProvider;
  /** Absent for a keyless provider, which stores no secret. */
  readonly apiKey?: string;
  readonly config: ModelConnectionConfigInput;
};

export type UpdateModelConnectionInput = {
  readonly name?: string;
  readonly config?: ModelConnectionConfigInput;
  /** A new key, written before the other fields; required when `config.baseUrl` changes. */
  readonly apiKey?: string;
};

export type ModelConnectionResource = {
  readonly id: string;
  readonly name: string;
  readonly provider: ModelProvider;
  readonly config: ModelConnectionConfigInput;
  readonly hasCredential: boolean;
  /**
   * #126's derived readiness: `hasCredential` (or a keyless provider) plus every config field this provider requires
   * being present. Computed on every read, never persisted — see
   * `docs/adr/W9-PLAN-credential-ownership-is-a-repository-invariant-not-a-foreign-key.md`
   * decision 3, "the only definition that cannot be stale".
   */
  readonly ready: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// ── The provider-discriminated config schema ────────────────────────────────────────────────────
//
// The per-provider rules are the published `MODEL_PROVIDER_CONFIG_RULES`; unknown keys are rejected
// and errors are field-level.

/** Every config field this provider must have for the connection to be usable, computed once. */
export function requiredConfigFields(
  provider: ModelProvider,
): readonly ModelConnectionConfigField[] {
  return MODEL_PROVIDER_CONFIG_RULES[provider].required;
}

/** Whether `config` has every field this provider requires — the non-credential half of readiness. */
export function isModelConnectionConfigComplete(
  provider: ModelProvider,
  config: ModelConnectionConfigInput,
): boolean {
  return requiredConfigFields(provider).every((field) => {
    const value = config[field];
    return typeof value === 'string' && value.trim() !== '';
  });
}

export type CheckBaseUrlEgress = (
  url: string,
) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;

/**
 * #126's "Base URLs are run through W9-PROV-127's egress policy at save time." Defaults to the
 * real policy read from the environment; a test may substitute its own to avoid a live DNS lookup,
 * the same seam `probe.ts` already uses for the same module (`probe.test.ts`, `vi.stubEnv`).
 */
export const defaultCheckBaseUrlEgress: CheckBaseUrlEgress = async (url) => {
  const decision = await checkEgress(url, loadEgressPolicyFromEnv());
  return decision.ok ? { ok: true } : { ok: false, reason: decision.reason };
};

async function parseProviderConfig(
  provider: ModelProvider,
  value: unknown,
  checkBaseUrlEgress: CheckBaseUrlEgress,
  installProjectId?: string,
): Promise<ParseResult<ModelConnectionConfigInput>> {
  const raw = value === undefined ? {} : object(value);
  if (raw === null) return { ok: false, errors: ['config must be an object.'] };
  const spec = MODEL_PROVIDER_CONFIG_RULES[provider];
  const errors: string[] = [];

  for (const key of Object.keys(raw)) {
    if (!MODEL_CONNECTION_CONFIG_FIELDS.includes(key as ModelConnectionConfigField)) {
      errors.push(`config.${key} is not supported.`);
    }
  }
  for (const field of MODEL_CONNECTION_CONFIG_FIELDS) {
    const present = raw[field] !== undefined;
    if (!present) continue;
    if (!spec.allowed.includes(field)) {
      errors.push(`config.${field} is not supported for the "${provider}" provider.`);
      continue;
    }
    if (typeof raw[field] !== 'string' || raw[field].trim() === '') {
      errors.push(`config.${field} must be a non-empty string.`);
    } else if (field === 'projectId' && !GCP_PROJECT_ID_PATTERN.test(raw[field])) {
      errors.push('config.projectId must be a Google Cloud project id.');
    } else if (
      field === 'projectId' &&
      installProjectId !== undefined &&
      raw[field] !== installProjectId
    ) {
      // The gateway calls Vertex AI as this install's own identity: it acts on its project only.
      errors.push("config.projectId must be this install's Google Cloud project.");
    } else if (field === 'location' && !VERTEX_LOCATIONS.includes(raw[field] as VertexLocation)) {
      errors.push(`config.location must be one of: ${VERTEX_LOCATIONS.join(', ')}.`);
    }
  }
  for (const field of spec.required) {
    if (raw[field] === undefined) {
      errors.push(`config.${field} is required for the "${provider}" provider.`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const parsed: {
    baseUrl?: string;
    deployment?: string;
    apiVersion?: string;
    projectId?: string;
    location?: VertexLocation;
  } = {};
  if (typeof raw['baseUrl'] === 'string') parsed.baseUrl = raw['baseUrl'];
  if (typeof raw['deployment'] === 'string') parsed.deployment = raw['deployment'];
  if (typeof raw['apiVersion'] === 'string') parsed.apiVersion = raw['apiVersion'];
  if (typeof raw['projectId'] === 'string') parsed.projectId = raw['projectId'];
  if (typeof raw['location'] === 'string') parsed.location = raw['location'] as VertexLocation;

  if (parsed.baseUrl !== undefined) {
    try {
      new URL(parsed.baseUrl);
    } catch {
      return { ok: false, errors: ['config.baseUrl must be an absolute URL.'] };
    }
    const egress = await checkBaseUrlEgress(parsed.baseUrl);
    if (!egress.ok) {
      return { ok: false, errors: [`config.baseUrl is not reachable: ${egress.reason}`] };
    }
  }
  return { ok: true, value: parsed };
}

export async function parseCreateModelConnection(
  value: unknown,
  checkBaseUrlEgress: CheckBaseUrlEgress = defaultCheckBaseUrlEgress,
  installProjectId?: string,
): Promise<ParseResult<CreateModelConnectionInput>> {
  const raw = object(value);
  if (raw === null) return { ok: false, errors: ['request body must be an object.'] };
  const allowed = new Set(['name', 'provider', 'apiKey', 'config']);
  const errors = Object.keys(raw)
    .filter((key) => !allowed.has(key))
    .map((key) => `${key} is not a field of this request.`);
  if (typeof raw['name'] !== 'string' || raw['name'].trim() === '')
    errors.push('name is required.');
  const providerValid = MODEL_PROVIDERS.includes(raw['provider'] as ModelProvider);
  if (!providerValid) errors.push('provider is not supported.');
  if (providerValid && isKeylessProvider(raw['provider'] as ModelProvider)) {
    if (raw['apiKey'] !== undefined) errors.push(KEYLESS_API_KEY_MESSAGE);
  } else if (typeof raw['apiKey'] !== 'string' || raw['apiKey'].length === 0) {
    errors.push('apiKey is required.');
  }
  if (errors.length > 0) return { ok: false, errors };

  const provider = raw['provider'] as ModelProvider;
  const parsedConfig = await parseProviderConfig(
    provider,
    raw['config'],
    checkBaseUrlEgress,
    installProjectId,
  );
  if (!parsedConfig.ok) return { ok: false, errors: parsedConfig.errors };
  return {
    ok: true,
    value: {
      name: raw['name'] as string,
      provider,
      ...(typeof raw['apiKey'] === 'string' ? { apiKey: raw['apiKey'] } : {}),
      config: parsedConfig.value,
    },
  };
}

/**
 * `provider` is the connection's existing, immutable provider — providers are write-once, set at
 * creation, so an update validates its `config` against the same rules `parseCreateModelConnection`
 * used for it, never against a provider the caller supplies.
 */
export async function parseUpdateModelConnection(
  value: unknown,
  provider: ModelProvider,
  checkBaseUrlEgress: CheckBaseUrlEgress = defaultCheckBaseUrlEgress,
  installProjectId?: string,
): Promise<ParseResult<UpdateModelConnectionInput>> {
  const raw = object(value);
  if (raw === null) return { ok: false, errors: ['request body must be an object.'] };
  const allowed = new Set(['name', 'config', 'apiKey']);
  const errors = Object.keys(raw)
    .filter((key) => !allowed.has(key))
    .map((key) => `${key} cannot be updated.`);
  if (raw['name'] !== undefined && (typeof raw['name'] !== 'string' || raw['name'].trim() === '')) {
    errors.push('name must be a non-empty string.');
  }
  if (raw['apiKey'] !== undefined && (typeof raw['apiKey'] !== 'string' || raw['apiKey'] === '')) {
    errors.push('apiKey must be a non-empty string.');
  } else if (raw['apiKey'] !== undefined && isKeylessProvider(provider)) {
    errors.push(KEYLESS_API_KEY_MESSAGE);
  }
  if (errors.length > 0) return { ok: false, errors };

  const fields = {
    ...(typeof raw['name'] === 'string' ? { name: raw['name'] } : {}),
    ...(typeof raw['apiKey'] === 'string' ? { apiKey: raw['apiKey'] } : {}),
  };
  if (raw['config'] === undefined) return { ok: true, value: fields };
  const parsedConfig = await parseProviderConfig(
    provider,
    raw['config'],
    checkBaseUrlEgress,
    installProjectId,
  );
  if (!parsedConfig.ok) return { ok: false, errors: parsedConfig.errors };
  return { ok: true, value: { ...fields, config: parsedConfig.value } };
}

/** What {@link toModelConnectionResource} reads of a stored connection; a repository record satisfies it. */
export interface ModelConnectionRow {
  readonly id: string;
  readonly name: string;
  readonly provider: ModelProvider;
  readonly config: ModelConnectionConfigInput;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toModelConnectionResource(
  connection: ModelConnectionRow,
  hasCredential: boolean,
): ModelConnectionResource {
  return {
    id: connection.id,
    name: connection.name,
    provider: connection.provider,
    config: connection.config,
    hasCredential,
    ready:
      (hasCredential || isKeylessProvider(connection.provider)) &&
      isModelConnectionConfigComplete(connection.provider, connection.config),
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
