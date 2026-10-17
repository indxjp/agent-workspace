/**
 * S1-21 (issue #500), ADR-0109 as amended: the local runtime's workspace API key may do what
 * `aw dev` needs and nothing that outlives the run.
 *
 * The key is `admin`, because model connections are an Admin grant (`rbac/permissions.ts`). Admin
 * also administers API keys, users and memberships, and a key minted through `POST /api/api-keys`
 * with the local key would keep working after the runtime revoked its own key on stop. So every
 * write on those three collections refuses a principal whose API key carries
 * {@link LOCAL_RUNTIME_API_KEY_NAME_PREFIX}, and `POST /api/api-keys` refuses that prefix in a new
 * key's name, so the in-process issuer is the only source of such a name and the prefix is a
 * reliable mark rather than a convention.
 *
 * The routes wrap their `Ownership` in {@link refusingLocalRuntimeKey}: an `OwnershipResolver`
 * runs inside `authorise` once the caller is verified and before `decide()`, so a refused call
 * reaches neither the decision nor the handler. Every other route, and every other key, is
 * untouched.
 */
import type { WorkspaceDirectory } from '../rbac/directory';
import {
  problem,
  type ApiResult,
  type OwnershipOutcome,
  type OwnershipResolver,
} from '../rbac/http';
import type { Ownership } from '../rbac/decide';
import type { Principal } from '../rbac/principal';
import { LOCAL_RUNTIME_API_KEY_NAME_PREFIX } from './local-credential';

/** Whether `principal` authenticated with a key the local runtime issued. */
async function isLocalRuntimeKey(
  principal: Principal,
  directory: WorkspaceDirectory,
): Promise<boolean> {
  const { apiKeyId } = principal;
  if (apiKeyId === null) return false;
  const keys = await directory.listApiKeys();
  const key = keys.find((row) => row.id === apiKeyId);
  return key !== undefined && key.name.startsWith(LOCAL_RUNTIME_API_KEY_NAME_PREFIX);
}

function localRuntimeKeyRefusal(): ApiResult {
  return problem(
    403,
    'local_runtime_key_not_permitted',
    'The local runtime’s API key cannot administer API keys, users or memberships. Sign in to the ' +
      'local workspace in the browser to do that.',
  );
}

/**
 * `ownership` (a fixed value, or a resolver run after this check), unless the caller holds the
 * local runtime's key: then the route answers `403 local_runtime_key_not_permitted` before
 * `decide()` runs.
 */
export function refusingLocalRuntimeKey(
  ownership: Ownership | OwnershipResolver,
): OwnershipResolver {
  return async (principal, directory): Promise<OwnershipOutcome> => {
    if (await isLocalRuntimeKey(principal, directory)) {
      return { kind: 'refuse', result: localRuntimeKeyRefusal() };
    }
    return typeof ownership === 'function'
      ? ownership(principal, directory)
      : { kind: 'ownership', ownership };
  };
}

/**
 * The answer `POST /api/api-keys` gives a body whose `name` starts with the reserved prefix, or
 * `null` for every other body (which the handler then validates as before).
 */
export function reservedKeyNameRefusal(body: unknown): ApiResult | null {
  if (typeof body !== 'object' || body === null || !('name' in body)) return null;
  const { name } = body;
  if (typeof name !== 'string') return null;
  return name.trimStart().startsWith(LOCAL_RUNTIME_API_KEY_NAME_PREFIX.trimEnd())
    ? problem(
        400,
        'reserved_name',
        `"name" may not start with ${JSON.stringify(LOCAL_RUNTIME_API_KEY_NAME_PREFIX.trimEnd())}: ` +
          'that prefix is reserved for the key the local runtime issues to aw dev.',
      )
    : null;
}
