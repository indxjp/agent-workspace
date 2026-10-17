/**
 * `GET /api/engines` — the engine catalogue this deployment offers (ENG-02c, #319).
 *
 * The whole of the route's behaviour, as a plain function of the registry, so a test drives it
 * without Next.js. `registry.ts` answers *which* engines this deployment registers; this module
 * answers what that catalogue looks like on the wire, and refuses to publish one the contract
 * cannot express.
 *
 * ## Why an unpublishable descriptor is a 500 and not a filtered 200
 *
 * `registeredEngines()` widens `id` to `string` so a test can register a descriptor `ENGINE_IDS`
 * does not list (see `registry.ts`). A body containing such an id would fail `EngineDescriptorSchema`
 * in the SDK, so the route cannot simply hand it over; dropping it instead would answer "these are
 * the engines this deployment offers" with a list that is not, and the caller's next decision —
 * which engine to put on an agent — would be taken against it. Refuse, never narrow (ADR-0065 D3).
 * The refusal is a `500` because nothing the caller wrote caused it: it is this deployment's own
 * registry that is wrong.
 */
import {
  ENGINE_PROBLEM_CODES,
  EngineListResponseSchema,
  type EngineListResponse,
} from '@indx-workspace/contracts/engines';

import { registeredEngines } from './registry';

/** A handler's answer before it becomes a `Response`, in `rbac/http.ts`'s shape. */
export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

/**
 * The catalogue, in the registry's order.
 *
 * Total: either every registered descriptor satisfies the published contract and the body is the
 * whole list, or one does not and the answer names that failure.
 */
export function listEngines(): ApiResult {
  const parsed = EngineListResponseSchema.safeParse({ engines: registeredEngines() });
  if (!parsed.success) {
    return {
      status: ENGINE_PROBLEM_CODES.engine_catalogue_invalid,
      body: {
        error: {
          code: 'engine_catalogue_invalid',
          message:
            'This deployment registers an engine the published engine contract cannot describe, ' +
            'so its catalogue cannot be served. No partial catalogue is returned in its place.',
        },
      },
    };
  }
  return { status: 200, body: parsed.data satisfies EngineListResponse };
}
