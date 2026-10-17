import type { UnavailableModelConnection } from '@indx-workspace/contracts/models';

import {
  isUuid,
  parseCreateModelConnection,
  parseUpdateModelConnection,
  type ModelConnectionResource,
} from './contract';
import type { ModelDiscovery } from './discovery';
import type { TestConnectionResult } from './probe';
import type { WorkspaceModelsStore } from './store';

export type ApiResult = { readonly status: number; readonly body: unknown };

export function problem(
  status: number,
  code: string,
  message: string,
  details?: readonly string[],
): ApiResult {
  return {
    status,
    body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
  };
}

function id(raw: unknown): { ok: true; value: string } | { ok: false; result: ApiResult } {
  return isUuid(raw)
    ? { ok: true, value: raw }
    : {
        ok: false,
        result: problem(
          400,
          'invalid_model_connection_id',
          'The model connection id is not a UUID.',
        ),
      };
}

function notFound(): ApiResult {
  return problem(
    404,
    'model_connection_not_found',
    'This workspace has no model connection with that id.',
  );
}

/**
 * `GET /api/model-connections` (issue #130, out-of-glob addition — see
 * `docs/adr/W9-MODEL-130-model-connections-list-route.md`): the connection view `listDiscoveredModels`'s
 * own doc comment already promised ("`GET /api/model-connections` is the connection view now") but
 * that commit never added. This is `#129`'s own deleted `listModels`, unchanged, under its intended
 * name — every model-selection surface that needs a connection's *name* (discovery rows carry only
 * a `connectionId`) reads this, joined against `GET /api/models` by
 * `apps/web/components/models/catalog.ts`'s `readCatalog`.
 */
export async function listModelConnections(store: WorkspaceModelsStore): Promise<ApiResult> {
  return { status: 200, body: { models: await store.list() } };
}

/**
 * `GET /api/models` (issue #129): discovered models, not connections — `GET /api/model-connections`
 * is the connection view now. Every ready connection in the workspace is discovered; an unready
 * one (no credential, or missing required config) is skipped rather than attempted, and a
 * connection whose discovery call itself failed is named in `unavailable` rather than silently
 * dropped (ADR-0015: an unavailable capability says so).
 */
export async function listDiscoveredModels(
  store: WorkspaceModelsStore,
  discover: ModelDiscovery,
): Promise<ApiResult> {
  const connections = await store.list();
  const models: Record<string, unknown>[] = [];
  const unavailable: UnavailableModelConnection[] = [];
  for (const connection of connections) {
    if (!connection.ready) continue;
    const resolved = await store.resolve(connection.id);
    if (resolved === null) continue;
    const result = await discover(resolved);
    if (result.ok) {
      models.push(...result.models);
    } else {
      unavailable.push({
        connectionId: connection.id,
        connectionName: connection.name,
        reason: result.reason,
        kind: result.failure.kind,
        ...('status' in result.failure ? { status: result.failure.status } : {}),
      });
    }
  }
  return {
    status: 200,
    body: { models, ...(unavailable.length > 0 ? { unavailable } : {}) },
  };
}

export async function createModelConnection(
  store: WorkspaceModelsStore,
  raw: unknown,
): Promise<ApiResult> {
  const parsed = await parseCreateModelConnection(raw);
  if (!parsed.ok)
    return problem(
      400,
      'invalid_body',
      'The model connection could not be created.',
      parsed.errors,
    );
  const outcome = await store.create(parsed.value);
  if (outcome.kind === 'name-conflict')
    return problem(
      409,
      'model_connection_name_conflict',
      `A connection named ${JSON.stringify(outcome.name)} already exists.`,
    );
  const resource = await store.get(outcome.connection.id);
  if (resource === null)
    return problem(
      500,
      'model_connection_disappeared',
      'The created connection could not be read back.',
    );
  return { status: 201, body: resource };
}

export async function getModelConnection(
  store: WorkspaceModelsStore,
  rawId: unknown,
): Promise<ApiResult> {
  const parsed = id(rawId);
  if (!parsed.ok) return parsed.result;
  const resource = await store.get(parsed.value);
  return resource === null ? notFound() : { status: 200, body: resource };
}

export async function updateModelConnection(
  store: WorkspaceModelsStore,
  rawId: unknown,
  raw: unknown,
): Promise<ApiResult> {
  const parsedId = id(rawId);
  if (!parsedId.ok) return parsedId.result;
  // The provider is write-once and its identity decides which config fields are even legal, so
  // the existing row is read before the body is validated — never the other way around.
  const existing = await store.get(parsedId.value);
  if (existing === null) return notFound();
  const parsed = await parseUpdateModelConnection(raw, existing.provider);
  if (!parsed.ok)
    return problem(
      400,
      'invalid_body',
      'The model connection could not be updated.',
      parsed.errors,
    );
  const { apiKey, ...fields } = parsed.value;
  // ADR-0077 D5, as for connectors: a saved key never follows its connection to a new `baseUrl`.
  // `model-connections: MANAGE` is not a secrets grant, so without this an Admin could point the
  // Owner's connection at a host of their own and collect the key on the next test or run.
  const retargets =
    fields.config !== undefined && fields.config.baseUrl !== existing.config.baseUrl;
  if (retargets && existing.hasCredential && apiKey === undefined) {
    return problem(
      409,
      'credential_required_on_retarget',
      'A new config.baseUrl needs a new apiKey in the same request; the saved key is not sent to a new destination.',
    );
  }
  // The key is written before the destination changes, so a failure in between never leaves the
  // old key pointed at the new host.
  if (apiKey !== undefined && !(await store.writeCredential(parsedId.value, apiKey))) {
    return notFound();
  }
  const outcome = await store.update(parsedId.value, fields);
  if (outcome.kind === 'not-found') return notFound();
  if (outcome.kind === 'name-conflict')
    return problem(
      409,
      'model_connection_name_conflict',
      `A connection named ${JSON.stringify(outcome.name)} already exists.`,
    );
  const resource = await store.get(outcome.connection.id);
  return resource === null ? notFound() : { status: 200, body: resource };
}

export async function deleteModelConnection(
  store: WorkspaceModelsStore,
  rawId: unknown,
): Promise<ApiResult> {
  const parsed = id(rawId);
  if (!parsed.ok) return parsed.result;
  const outcome = await store.delete(parsed.value);
  // #126: deletion "reports the referencing agents ... first" — the agents this connection's
  // deletion just fell back to their workspace default, named while they can still be named.
  return outcome.kind === 'deleted'
    ? { status: 200, body: { deleted: true, referencedBy: outcome.referencedBy } }
    : notFound();
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `POST /api/model-connections/:id/credential` — #126's write-only rotation route. */
export async function rotateModelConnectionCredential(
  store: WorkspaceModelsStore,
  rawId: unknown,
  raw: unknown,
): Promise<ApiResult> {
  const parsed = id(rawId);
  if (!parsed.ok) return parsed.result;
  const body = asObject(raw);
  const errors: string[] = [];
  if (body === null) {
    errors.push('request body must be an object.');
  } else {
    const allowed = new Set(['apiKey']);
    errors.push(
      ...Object.keys(body)
        .filter((key) => !allowed.has(key))
        .map((key) => `${key} is not a field of this request.`),
    );
    if (typeof body['apiKey'] !== 'string' || body['apiKey'].length === 0) {
      errors.push('apiKey is required.');
    }
  }
  if (errors.length > 0) {
    return problem(400, 'invalid_body', 'The credential could not be rotated.', errors);
  }
  const apiKey = (body as Record<string, unknown>)['apiKey'] as string;
  const rotated = await store.replaceCredential(parsed.value, apiKey);
  // Never a body: the one job of this route is to not say anything about the key it just wrote.
  return rotated ? { status: 204, body: null } : notFound();
}

export async function testModelConnection(
  store: WorkspaceModelsStore,
  rawId: unknown,
  probe: (
    resolved: NonNullable<Awaited<ReturnType<WorkspaceModelsStore['resolve']>>>,
  ) => Promise<TestConnectionResult>,
): Promise<ApiResult> {
  const parsed = id(rawId);
  if (!parsed.ok) return parsed.result;
  const resolved = await store.resolve(parsed.value);
  if (resolved === null) return notFound();
  const result = await probe(resolved);
  return { status: result.ok ? 200 : 502, body: result };
}

export function responseResource(body: unknown): ModelConnectionResource | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  return 'id' in body && 'name' in body ? (body as ModelConnectionResource) : null;
}
