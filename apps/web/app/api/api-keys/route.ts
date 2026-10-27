/**
 * `GET /api/api-keys` and `POST /api/api-keys` — spec §22's list and its `+ Create API Key`.
 *
 * Neither is printed by §34, so both carry a `mandate` on §22 in
 * `tests/route-declarations/W2-CP-06.ts`.
 *
 * The `POST` is the only place in this program that returns a key in full. §22: *"Show the raw
 * secret only once. Store only a secure hash."* The `GET` on the same path returns
 * `ApiKeySummary`, a type with nowhere to put a secret, which is what makes a second read of this
 * endpoint unable to re-reveal one rather than merely unlikely to.
 */
import {
  refusingLocalRuntimeKey,
  reservedKeyNameRefusal,
} from '../../../server/cli-auth/local-runtime-key-guard';
import { createApiKey, listApiKeys } from '../../../server/rbac/handlers';
import { readJsonBody } from '../../../server/http/result';
import { authorise, toResponse } from '../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** `GET /api/api-keys` — §22's list. Prefixes and timestamps; never a secret. */
export async function GET(request: Request): Promise<Response> {
  const result = await authorise(request, 'not-applicable', ({ directory }) =>
    listApiKeys(directory),
  );
  return toResponse(result);
}

/**
 * `POST /api/api-keys` — mint one key, store its hash, return the key once.
 *
 * The local runtime's own key may not mint one (a child key would outlive the run), and no key may
 * be named with the prefix reserved for it (S1-21, `local-runtime-key-guard.ts`).
 */
export async function POST(request: Request): Promise<Response> {
  const ownership = refusingLocalRuntimeKey('not-applicable');
  const result = await authorise(request, ownership, async ({ directory, principal }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.result;
    const reserved = reservedKeyNameRefusal(body.value);
    if (reserved !== null) return reserved;
    // §22's key carries a role of its own, so minting one is a conferral: a key an Admin minted
    // with `role: 'owner'` would authenticate as an Owner on every later request. Measured
    // against the minter's own role in `conferral.ts`, like every other role in a body.
    return createApiKey(directory, principal.role, body.value);
  });
  return toResponse(result);
}
