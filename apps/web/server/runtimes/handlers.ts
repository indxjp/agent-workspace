/**
 * The five runtime-profile operations of spec §34's shape rule, as functions of a store and a
 * parsed body. Copies `apps/web/server/agents/handlers.ts`'s split exactly: nothing here touches
 * `Request` or `Response`, which is what lets `routes.test.ts` exercise every status code and every
 * outcome without constructing a web request.
 *
 *   POST   /api/runtime-profiles        {@link createRuntimeProfile}
 *   GET    /api/runtime-profiles        {@link listRuntimeProfiles}
 *   GET    /api/runtime-profiles/:id    {@link getRuntimeProfile}
 *   PATCH  /api/runtime-profiles/:id    {@link updateRuntimeProfile}
 *   DELETE /api/runtime-profiles/:id    {@link deleteRuntimeProfile}
 */
import { EXTERNAL_RUNTIME_PROVIDERS } from '../../contracts/runtimes';
import {
  isUuid,
  parseCreateRuntimeProfileInput,
  parseUpdateRuntimeProfilePatch,
  toRuntimeProfileResource,
  type RuntimeProfileResource,
} from './contract';
import type { RuntimeNetworkPolicyLookup } from './registry';
import type { WorkspaceRuntimeProfileStore } from './store';
import { problem, type ApiResult } from '../http/result';

/** `runtime_profiles.id` is a `uuid` column, so a non-UUID cannot match a row (ADR-0015). */
export function requireRuntimeProfileId(
  raw: unknown,
): { ok: true; id: string } | { ok: false; result: ApiResult } {
  if (isUuid(raw)) return { ok: true, id: raw };
  return {
    ok: false,
    result: problem(
      400,
      'invalid_runtime_profile_id',
      'The runtime-profile id in the path is not a UUID.',
    ),
  };
}

function runtimeProfileNotFound(): ApiResult {
  return problem(
    404,
    'runtime_profile_not_found',
    'This workspace has no runtime profile with that id.',
  );
}

/**
 * Refuse a policy the driver cannot enforce here, naming the driver and the accepted values.
 *
 * This is an owned API, so an unenforceable request is rejected rather than coerced: the profile
 * would otherwise be stored, pass "Test Runtime" (which probes with the deployment's own policy,
 * not the profile's) and fail inside the driver on every run instead.
 */
async function refuseUnenforceableNetworkPolicy(
  driver: string,
  networkPolicy: string,
  enforceableNetworkPolicies: RuntimeNetworkPolicyLookup,
): Promise<ApiResult | null> {
  const enforceable = await enforceableNetworkPolicies(driver);
  if (enforceable === null || enforceable.some((policy) => policy === networkPolicy)) return null;
  const accepted = enforceable.map((policy) => JSON.stringify(policy)).join(', ');
  return problem(
    422,
    'network_policy_not_enforceable',
    `The ${driver} runtime in this deployment cannot enforce networkPolicy ` +
      `${JSON.stringify(networkPolicy)}; it accepts ${accepted}.`,
  );
}

/**
 * Refuse a sandbox provider the `external` driver does not have. `driverConfig` stays a free-form
 * escape hatch for every other driver, so only an `external` profile is held to the list; an absent
 * `provider` means E2B, which is what `external` has always meant.
 */
function refuseUnknownExternalProvider(
  driver: string,
  driverConfig: Readonly<Record<string, unknown>> | null | undefined,
): ApiResult | null {
  if (driver !== 'external' || driverConfig === null || driverConfig === undefined) return null;
  const provider = driverConfig['provider'];
  if (provider === undefined) return null;
  if (
    typeof provider === 'string' &&
    EXTERNAL_RUNTIME_PROVIDERS.some((known) => known === provider)
  ) {
    return null;
  }
  const named = typeof provider === 'string' ? ` ${JSON.stringify(provider.slice(0, 64))}` : '';
  return problem(
    422,
    'runtime_provider_unsupported',
    `The external runtime has no provider${named}; driverConfig.provider must be one of ` +
      `${EXTERNAL_RUNTIME_PROVIDERS.map((known) => JSON.stringify(known)).join(', ')}, or omitted.`,
  );
}

/** `POST /api/runtime-profiles` — 201, or 400 / 409 / 422 naming what went wrong. */
export async function createRuntimeProfile(
  store: WorkspaceRuntimeProfileStore,
  rawBody: unknown,
  enforceableNetworkPolicies: RuntimeNetworkPolicyLookup,
): Promise<ApiResult> {
  const parsed = parseCreateRuntimeProfileInput(rawBody);
  if (!parsed.ok) {
    return problem(
      400,
      'invalid_body',
      'The runtime profile could not be created from this body.',
      parsed.errors,
    );
  }
  const refusal = await refuseUnenforceableNetworkPolicy(
    parsed.value.driver,
    parsed.value.networkPolicy,
    enforceableNetworkPolicies,
  );
  if (refusal !== null) return refusal;
  const providerRefusal = refuseUnknownExternalProvider(
    parsed.value.driver,
    parsed.value.driverConfig,
  );
  if (providerRefusal !== null) return providerRefusal;
  const outcome = await store.create(parsed.value);
  switch (outcome.kind) {
    case 'created':
      return { status: 201, body: toRuntimeProfileResource(outcome.profile) };
    case 'name-conflict':
      return problem(
        409,
        'runtime_profile_name_conflict',
        `This workspace already has a runtime profile named ${JSON.stringify(outcome.name)}.`,
      );
    case 'unknown-runtime-connection':
      return problem(
        400,
        'unknown_runtime_connection',
        'runtimeConnectionId does not name a runtime connection in this workspace.',
      );
    default: {
      const unreachable: never = outcome;
      return problem(
        500,
        'unhandled_store_outcome',
        `The store returned an outcome this route does not handle: ${JSON.stringify(unreachable)}.`,
      );
    }
  }
}

/** `GET /api/runtime-profiles` — 200 with this workspace's profiles. Never another workspace's. */
export async function listRuntimeProfiles(store: WorkspaceRuntimeProfileStore): Promise<ApiResult> {
  const profiles = await store.list();
  const items: RuntimeProfileResource[] = profiles.map(toRuntimeProfileResource);
  return { status: 200, body: { runtimeProfiles: items } };
}

/** `GET /api/runtime-profiles/:id` — 200, or 404 for an id this workspace does not have. */
export async function getRuntimeProfile(
  store: WorkspaceRuntimeProfileStore,
  rawId: unknown,
): Promise<ApiResult> {
  const id = requireRuntimeProfileId(rawId);
  if (!id.ok) return id.result;
  const profile = await store.get(id.id);
  if (profile === null) return runtimeProfileNotFound();
  return { status: 200, body: toRuntimeProfileResource(profile) };
}

/** `PATCH /api/runtime-profiles/:id` — 200, or 400 / 404 / 409 / 422. */
export async function updateRuntimeProfile(
  store: WorkspaceRuntimeProfileStore,
  rawId: unknown,
  rawBody: unknown,
  enforceableNetworkPolicies: RuntimeNetworkPolicyLookup,
): Promise<ApiResult> {
  const id = requireRuntimeProfileId(rawId);
  if (!id.ok) return id.result;
  const parsed = parseUpdateRuntimeProfilePatch(rawBody);
  if (!parsed.ok) {
    return problem(
      400,
      'invalid_body',
      'The runtime profile could not be updated from this body.',
      parsed.errors,
    );
  }
  if (
    parsed.value.networkPolicy !== undefined ||
    parsed.value.driver !== undefined ||
    parsed.value.driverConfig !== undefined
  ) {
    // The guard answers for the pair that will be stored, not for the patched field alone: a
    // patch may carry a policy without a driver, or a driver without a policy, and either half
    // falls back to the stored row. A patch for a profile this workspace does not have is the
    // existing 404, never a policy refusal that would reveal the row.
    const stored = await store.get(id.id);
    if (stored === null) return runtimeProfileNotFound();
    const refusal = await refuseUnenforceableNetworkPolicy(
      parsed.value.driver ?? stored.driver,
      parsed.value.networkPolicy ?? stored.networkPolicy,
      enforceableNetworkPolicies,
    );
    if (refusal !== null) return refusal;
    const providerRefusal = refuseUnknownExternalProvider(
      parsed.value.driver ?? stored.driver,
      parsed.value.driverConfig === undefined ? stored.driverConfig : parsed.value.driverConfig,
    );
    if (providerRefusal !== null) return providerRefusal;
  }
  const outcome = await store.update(id.id, parsed.value);
  switch (outcome.kind) {
    case 'updated':
      return { status: 200, body: toRuntimeProfileResource(outcome.profile) };
    case 'not-found':
      return runtimeProfileNotFound();
    case 'name-conflict':
      return problem(
        409,
        'runtime_profile_name_conflict',
        `This workspace already has a runtime profile named ${JSON.stringify(outcome.name)}.`,
      );
    case 'unknown-runtime-connection':
      return problem(
        400,
        'unknown_runtime_connection',
        'runtimeConnectionId does not name a runtime connection in this workspace.',
      );
    default: {
      const unreachable: never = outcome;
      return problem(
        500,
        'unhandled_store_outcome',
        `The store returned an outcome this route does not handle: ${JSON.stringify(unreachable)}.`,
      );
    }
  }
}

/**
 * `DELETE /api/runtime-profiles/:id` — 204, or 404.
 *
 * Deleting an agent's referenced profile does not cascade — `agents.runtime_profile_id` is
 * `ON DELETE SET NULL` — so this can never fail with "still referenced"; it always either finds
 * the row or does not.
 */
export async function deleteRuntimeProfile(
  store: WorkspaceRuntimeProfileStore,
  rawId: unknown,
): Promise<ApiResult> {
  const id = requireRuntimeProfileId(rawId);
  if (!id.ok) return id.result;
  const outcome = await store.delete(id.id);
  switch (outcome.kind) {
    case 'deleted':
      return { status: 204, body: null };
    case 'not-found':
      return runtimeProfileNotFound();
    default: {
      const unreachable: never = outcome;
      return problem(
        500,
        'unhandled_store_outcome',
        `The store returned an outcome this route does not handle: ${JSON.stringify(unreachable)}.`,
      );
    }
  }
}
