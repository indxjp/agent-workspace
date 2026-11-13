import {
  MODEL_CONNECTION_CONFIG_FIELDS,
  MODEL_PROVIDER_CONFIG_RULES,
  VERTEX_LOCATIONS,
  isKeylessProvider,
  type CreateModelConnectionInput,
  type ModelConnectionConfigInput,
  type ModelConnectionConfigField,
  type UpdateModelConnectionPatch,
  type VertexLocation,
} from '@indx-workspace/contracts/models';
import type { ModelProvider } from '@indx-workspace/contracts/runs';

import { modelsStrings, type ModelsStrings } from './models-messages';

export const PROVIDER_CHOICES = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude models through the native Anthropic Messages API.',
  },
  {
    id: 'anthropic-compatible',
    label: 'Anthropic-compatible endpoint',
    description: 'A configurable endpoint that speaks the Anthropic Messages API.',
  },
  {
    id: 'azure-openai',
    label: 'Microsoft Azure OpenAI',
    description: 'An Azure deployment translated by the internal gateway.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'OpenAI Responses API models translated by the internal gateway.',
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible endpoint',
    description: 'A configurable endpoint such as vLLM, Ollama, or a vendor gateway.',
  },
  {
    id: 'vertex',
    label: 'Claude on Google Cloud (Vertex AI)',
    description: "Claude through this install's Google Cloud identity. No API key.",
  },
] as const satisfies readonly {
  readonly id: ModelProvider;
  readonly label: string;
  readonly description: string;
}[];

export type ProviderId = ModelProvider;

export type ModelConnectionView = {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderId;
  readonly config: {
    readonly baseUrl?: string;
    readonly deployment?: string;
    readonly apiVersion?: string;
    readonly projectId?: string;
    readonly location?: VertexLocation;
  };
  readonly hasCredential: boolean;
  /**
   * `#126`'s derived readiness (`hasCredential` plus every config field the provider requires).
   * Parsed leniently — defaults to `false` when the server omits it — so an older cached response
   * shape does not throw where {@link readModelConnections} otherwise rejects the whole list.
   */
  readonly ready: boolean;
};

export type ProviderFormValues = {
  readonly name: string;
  readonly provider: ProviderId;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly deployment: string;
  readonly apiVersion: string;
  readonly projectId: string;
  readonly location: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isVertexLocation(value: unknown): value is VertexLocation {
  return VERTEX_LOCATIONS.some((location) => location === value);
}

function readConfig(value: unknown): ModelConnectionView['config'] {
  const source = record(value);
  if (source === null) return {};
  return {
    ...(typeof source['baseUrl'] === 'string' ? { baseUrl: source['baseUrl'] } : {}),
    ...(typeof source['deployment'] === 'string' ? { deployment: source['deployment'] } : {}),
    ...(typeof source['apiVersion'] === 'string' ? { apiVersion: source['apiVersion'] } : {}),
    ...(typeof source['projectId'] === 'string' ? { projectId: source['projectId'] } : {}),
    ...(isVertexLocation(source['location']) ? { location: source['location'] } : {}),
  };
}

const API_PROVIDER_IDS = new Set<string>(PROVIDER_CHOICES.map((provider) => provider.id));

/** Parse the public resource shape and intentionally discard every undeclared field. */
export function readModelConnections(body: unknown): readonly ModelConnectionView[] {
  const outer = record(body);
  if (outer === null || !Array.isArray(outer['models'])) {
    throw new Error('The models response has no list.');
  }
  return outer['models'].map((entry, index) => {
    const value = record(entry);
    if (
      value === null ||
      typeof value['id'] !== 'string' ||
      typeof value['name'] !== 'string' ||
      typeof value['provider'] !== 'string' ||
      !API_PROVIDER_IDS.has(value['provider']) ||
      typeof value['hasCredential'] !== 'boolean'
    ) {
      throw new Error(`Model connection ${String(index)} is invalid.`);
    }
    return {
      id: value['id'],
      name: value['name'],
      provider: value['provider'] as ModelConnectionView['provider'],
      config: readConfig(value['config']),
      hasCredential: value['hasCredential'],
      ready: typeof value['ready'] === 'boolean' ? value['ready'] : false,
    };
  });
}

export function providerLabel(provider: ModelConnectionView['provider']): string {
  return PROVIDER_CHOICES.find((choice) => choice.id === provider)?.label ?? provider;
}

/**
 * The status a connection's row and detail panel show. Derived from server data only (`#128`'s
 * Minimum implementation) — `ready` is `hasCredential` plus every config field the provider
 * requires, computed server-side by `toModelConnectionResource`, never re-derived here.
 */
export type ConnectionStatusKind = 'credential-missing' | 'incomplete' | 'ready';

export type ConnectionStatus = {
  /** Which of the three it is, for a screen that words it in the reader's language. */
  readonly kind: ConnectionStatusKind;
  readonly text: string;
  readonly tone: 'ok' | 'warn' | 'danger';
};

export function connectionStatus(
  connection: Pick<ModelConnectionView, 'provider' | 'hasCredential' | 'ready'>,
): ConnectionStatus {
  // A keyless provider never has a credential; only its configuration can be incomplete.
  if (!connection.hasCredential && !isKeylessProvider(connection.provider))
    return { kind: 'credential-missing', text: 'Credential missing', tone: 'danger' };
  if (!connection.ready)
    return { kind: 'incomplete', text: 'Configuration incomplete', tone: 'warn' };
  return { kind: 'ready', text: 'Ready', tone: 'ok' };
}

/** The row's detail line, worded by `strings` (English by default); the values are the server's. */
export function connectionDetail(
  connection: ModelConnectionView,
  strings: ModelsStrings = modelsStrings('en'),
): string {
  const details = [strings.providerLabel[connection.provider]];
  if (connection.config.baseUrl !== undefined) details.push(connection.config.baseUrl);
  if (connection.config.deployment !== undefined)
    details.push(strings.detailDeployment(connection.config.deployment));
  if (connection.config.apiVersion !== undefined)
    details.push(strings.detailApiVersion(connection.config.apiVersion));
  if (connection.config.projectId !== undefined)
    details.push(strings.detailProject(connection.config.projectId));
  if (connection.config.location !== undefined) details.push(connection.config.location);
  return details.join(' · ');
}

/** Only the fields the provider accepts: a value typed before a provider switch is never sent. */
function configPayload(
  values: Readonly<Record<ModelConnectionConfigField, string>>,
  provider: ProviderId,
): ModelConnectionConfigInput {
  const config: { -readonly [field in keyof ModelConnectionConfigInput]: string } & {
    location?: VertexLocation;
  } = {};
  for (const field of editableConfigFields(provider)) {
    const value = values[field].trim();
    if (value === '') continue;
    if (field === 'location') {
      if (isVertexLocation(value)) config.location = value;
    } else {
      config[field] = value;
    }
  }
  return config;
}

export function createConnectionPayload(values: ProviderFormValues): CreateModelConnectionInput {
  const base = { name: values.name.trim(), provider: values.provider };
  // A keyless provider takes no key at all: the server refuses one.
  return isKeylessProvider(values.provider)
    ? { ...base, config: configPayload(values, values.provider) }
    : { ...base, apiKey: values.apiKey, config: configPayload(values, values.provider) };
}

/** The config fields the provider accepts, in the form's display order. */
export function editableConfigFields(provider: ProviderId): readonly ModelConnectionConfigField[] {
  return MODEL_CONNECTION_CONFIG_FIELDS.filter((field) =>
    MODEL_PROVIDER_CONFIG_RULES[provider].allowed.includes(field),
  );
}

/** The config fields the provider requires, in the form's display order. */
export function requiredConfigFields(provider: ProviderId): readonly ModelConnectionConfigField[] {
  return MODEL_CONNECTION_CONFIG_FIELDS.filter((field) =>
    MODEL_PROVIDER_CONFIG_RULES[provider].required.includes(field),
  );
}

function hasRequiredConfig(
  values: Readonly<Record<ModelConnectionConfigField, string>>,
  provider: ProviderId,
): boolean {
  return requiredConfigFields(provider).every((field) => values[field].trim() !== '');
}

export function isProviderFormComplete(values: ProviderFormValues): boolean {
  if (values.name.trim() === '') return false;
  // A keyless provider needs no key, and the server fills in the install's project when none is typed.
  if (isKeylessProvider(values.provider)) return true;
  return values.apiKey !== '' && hasRequiredConfig(values, values.provider);
}

// ── The provider detail/edit panel (`#128`) ─────────────────────────────────────────────────────

export type EditFormValues = {
  readonly name: string;
  readonly baseUrl: string;
  readonly deployment: string;
  readonly apiVersion: string;
  readonly projectId: string;
  readonly location: string;
};

export function isEditFormValid(values: EditFormValues, provider: ProviderId): boolean {
  if (values.name.trim() === '') return false;
  return hasRequiredConfig(values, provider);
}

export function updateConnectionPayload(
  values: EditFormValues,
  provider: ProviderId,
): UpdateModelConnectionPatch {
  return { name: values.name.trim(), config: configPayload(values, provider) };
}

/** The problem shape every route in this task's blast radius answers with (`server/models/handlers.ts`). */
export function formatApiError(body: unknown): string {
  const outer = record(body);
  const problem = outer === null ? null : record(outer['error']);
  const message =
    problem !== null && typeof problem['message'] === 'string' ? problem['message'] : null;
  const details = problem !== null && Array.isArray(problem['details']) ? problem['details'] : [];
  const detailText = details
    .filter((entry): entry is string => typeof entry === 'string')
    .join(' ');
  if (message !== null && detailText !== '') return `${message} ${detailText}`;
  if (message !== null) return message;
  return detailText !== '' ? detailText : 'The request failed.';
}

/** One agent, as much of `GET /api/agents`' shape as the remove-flow preview needs. */
export type AgentSummary = {
  readonly id: string;
  readonly name: string;
  readonly modelConnectionId: string | null;
};

/** Parsed leniently: a malformed entry is skipped, not fatal — this is a preview, not the record of truth. */
export function readAgentSummaries(body: unknown): readonly AgentSummary[] {
  const outer = record(body);
  if (outer === null || !Array.isArray(outer['agents'])) return [];
  const summaries: AgentSummary[] = [];
  for (const entry of outer['agents']) {
    const value = record(entry);
    if (value === null || typeof value['id'] !== 'string' || typeof value['name'] !== 'string')
      continue;
    const modelConnectionId =
      typeof value['modelConnectionId'] === 'string' ? value['modelConnectionId'] : null;
    summaries.push({ id: value['id'], name: value['name'], modelConnectionId });
  }
  return summaries;
}

/** One entry of the delete endpoint's `referencedBy` — the shape the remove flow's preview and the
 * server's authoritative report share, so a preview and the report after deleting read identically. */
export type ReferencingAgent = { readonly agentId: string; readonly agentName: string };

export function agentsReferencing(
  agents: readonly AgentSummary[],
  connectionId: string,
): readonly ReferencingAgent[] {
  return agents
    .filter((agent) => agent.modelConnectionId === connectionId)
    .map((agent) => ({ agentId: agent.id, agentName: agent.name }));
}

/**
 * The remove flow's confirmation gate: the caller must type the connection's exact name before the
 * delete button enables. Exact, case-sensitive match — a fuzzy match would let a mis-typed name
 * through, which is the one thing this control exists to prevent.
 */
export function confirmationMatches(input: string, connectionName: string): boolean {
  return input === connectionName;
}
