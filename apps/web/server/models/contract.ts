import { checkEgress, loadEgressPolicyFromEnv } from '@agent-workspace/core';
import type { ModelConnectionRecord } from '@agent-workspace/core/db';
import { MODEL_PROVIDERS, type ModelProvider } from '@indx-workspace/contracts/runs';

// The three fields are typed `T | undefined`, not the shorthand `T`, because this must accept
// `ModelConnectionRecord['config']` as-is: that type comes from `packages/core`'s Zod schema,
// where `exactOptionalPropertyTypes` makes an `.optional()` field's inferred type `T | undefined`,
// not merely omittable.
export type ModelConnectionConfigInput = {
  readonly baseUrl?: string | undefined;
  readonly deployment?: string | undefined;
  readonly apiVersion?: string | undefined;
};

export type CreateModelConnectionInput = {
  readonly name: string;
  readonly provider: ModelProvider;
  readonly apiKey: string;
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
  readonly config: ModelConnectionRecord['config'];
  readonly hasCredential: boolean;
  /**
   * #126's derived readiness: `hasCredential` plus every config field this provider requires
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
// §126's Minimum implementation, verbatim: "Anthropic and OpenAI require nothing beyond an
// optional base URL, OpenAI-compatible requires baseUrl, Azure requires baseUrl + apiVersion +
// deployment. Unknown keys rejected, errors field-level." `anthropic-compatible` follows the same
// rule as `anthropic` — `probe.ts`'s `endpoint()` already treats the two identically, and the
// issue's only reason to distinguish "Anthropic-compatible" at all is a UI choice (`#128`'s job,
// per this task's "Deliberately not built").
type ConfigField = 'baseUrl' | 'deployment' | 'apiVersion';
const CONFIG_FIELDS: readonly ConfigField[] = ['baseUrl', 'deployment', 'apiVersion'];

type ProviderConfigSpec = {
  readonly allowed: readonly ConfigField[];
  readonly required: readonly ConfigField[];
};

const PROVIDER_CONFIG_SPEC: Readonly<Record<ModelProvider, ProviderConfigSpec>> = {
  anthropic: { allowed: ['baseUrl'], required: [] },
  'anthropic-compatible': { allowed: ['baseUrl'], required: [] },
  openai: { allowed: ['baseUrl'], required: [] },
  'openai-compatible': { allowed: ['baseUrl'], required: ['baseUrl'] },
  'azure-openai': {
    allowed: ['baseUrl', 'apiVersion', 'deployment'],
    required: ['baseUrl', 'apiVersion', 'deployment'],
  },
};

/** Every config field this provider must have for the connection to be usable, computed once. */
export function requiredConfigFields(provider: ModelProvider): readonly ConfigField[] {
  return PROVIDER_CONFIG_SPEC[provider].required;
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
): Promise<ParseResult<ModelConnectionConfigInput>> {
  const raw = value === undefined ? {} : object(value);
  if (raw === null) return { ok: false, errors: ['config must be an object.'] };
  const spec = PROVIDER_CONFIG_SPEC[provider];
  const errors: string[] = [];

  for (const key of Object.keys(raw)) {
    if (!CONFIG_FIELDS.includes(key as ConfigField)) errors.push(`config.${key} is not supported.`);
  }
  for (const field of CONFIG_FIELDS) {
    const present = raw[field] !== undefined;
    if (!present) continue;
    if (!spec.allowed.includes(field)) {
      errors.push(`config.${field} is not supported for the "${provider}" provider.`);
      continue;
    }
    if (typeof raw[field] !== 'string' || raw[field].trim() === '') {
      errors.push(`config.${field} must be a non-empty string.`);
    }
  }
  for (const field of spec.required) {
    if (raw[field] === undefined) {
      errors.push(`config.${field} is required for the "${provider}" provider.`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const parsed: { baseUrl?: string; deployment?: string; apiVersion?: string } = {};
  if (typeof raw['baseUrl'] === 'string') parsed.baseUrl = raw['baseUrl'];
  if (typeof raw['deployment'] === 'string') parsed.deployment = raw['deployment'];
  if (typeof raw['apiVersion'] === 'string') parsed.apiVersion = raw['apiVersion'];

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
  if (typeof raw['apiKey'] !== 'string' || raw['apiKey'].length === 0)
    errors.push('apiKey is required.');
  if (errors.length > 0) return { ok: false, errors };

  const provider = raw['provider'] as ModelProvider;
  const parsedConfig = await parseProviderConfig(provider, raw['config'], checkBaseUrlEgress);
  if (!parsedConfig.ok) return { ok: false, errors: parsedConfig.errors };
  return {
    ok: true,
    value: {
      name: raw['name'] as string,
      provider,
      apiKey: raw['apiKey'] as string,
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
  }
  if (errors.length > 0) return { ok: false, errors };

  const fields = {
    ...(typeof raw['name'] === 'string' ? { name: raw['name'] } : {}),
    ...(typeof raw['apiKey'] === 'string' ? { apiKey: raw['apiKey'] } : {}),
  };
  if (raw['config'] === undefined) return { ok: true, value: fields };
  const parsedConfig = await parseProviderConfig(provider, raw['config'], checkBaseUrlEgress);
  if (!parsedConfig.ok) return { ok: false, errors: parsedConfig.errors };
  return { ok: true, value: { ...fields, config: parsedConfig.value } };
}

export function toModelConnectionResource(
  connection: ModelConnectionRecord,
  hasCredential: boolean,
): ModelConnectionResource {
  return {
    id: connection.id,
    name: connection.name,
    provider: connection.provider,
    config: connection.config,
    hasCredential,
    ready: hasCredential && isModelConnectionConfigComplete(connection.provider, connection.config),
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
