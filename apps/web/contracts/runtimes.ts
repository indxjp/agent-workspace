/**
 * The runtime wire contract lives in `@indx-workspace/contracts/runtimes`, the package the SDK
 * and every external consumer validate against. This module is the application's import seam
 * (`docs/sdk/03-sdk-design.md`): browser and server code keep importing `contracts/runtimes` while
 * the canonical vocabulary and schemas live in the package. Only the capability helper below is
 * application-owned — it encodes this deployment's defaults, not the API's shape.
 */
import type { RuntimeNetworkPolicy } from '@indx-workspace/contracts/runtimes';

export {
  EXTERNAL_RUNTIME_PROVIDERS,
  RUNTIME_DRIVERS,
  RUNTIME_FILESYSTEM_MODES,
  RUNTIME_NETWORK_POLICIES,
  RUNTIME_PROFILE_BOUNDS,
  RuntimeConnectionListResponseSchema,
  RuntimeConnectionResourceSchema,
  RuntimeProfileListResponseSchema,
  RuntimeProfileResourceSchema,
  type CreateRuntimeConnectionInput,
  type CreateRuntimeProfileInput,
  type ExternalRuntimeProvider,
  type RuntimeConnectionResource,
  type RuntimeDriver,
  type RuntimeFilesystemMode,
  type RuntimeNetworkPolicy,
  type RuntimeProfileResource,
  type UpdateRuntimeProfilePatch,
} from '@indx-workspace/contracts/runtimes';

/** Choose the strongest default policy that the selected runtime can enforce. */
export function defaultRuntimeNetworkPolicy(runtime: string): RuntimeNetworkPolicy {
  if (runtime === 'local') return 'open';
  if (runtime === 'kubernetes') return 'restricted';
  return 'none';
}
