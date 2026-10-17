/**
 * The invitation token — issue #121's "random, hashed at rest, single-use, expiring, and
 * workspace-bound".
 *
 * Unlike `apps/web/server/rbac/api-key.ts`'s two-halved format, an invitation token has no public
 * half to display: nothing shows a list of live invitations back to the person redeeming one, the
 * way §22's API-key screen shows `ak_live_********`. So the whole token is one random secret —
 * `randomToken` and `hashApiKeySecret` from `api-key.ts`, reused rather than re-implemented, are
 * this file's whole cryptographic surface, per that file's own "one cryptographic surface" header.
 *
 * The row an invitee redeems is found by the `id` `POST /api/invitations` returns (not a secret —
 * the same role `keyPrefix` plays for an API key: safe to log, safe to put in a URL, never enough
 * to authenticate on its own) together with this token. `apps/web/server/invitations/handlers.ts`'s
 * `acceptInvitation` looks the row up by `(id, hash(token), email)` together, in one query, so a
 * wrong id, a wrong token and a wrong email are indistinguishable to the caller — see
 * `packages/core/src/db/repositories/directory.ts`'s `AcceptInvitationOutcome` for why.
 */
import { hashApiKeySecret, randomToken } from '../rbac/api-key';

/** 32 random bytes — 256 bits — the same entropy budget R-12 §1.2 gives an API key's secret half. */
const TOKEN_BYTES = 32;

/**
 * How long a freshly minted or resent invitation stays live. Not configurable: this deployment's
 * `sendInvitation` is manual-link-only (declared gap G-10), so the inviter controls how quickly the
 * link actually reaches the invitee, and a week is long enough to survive that without leaving a
 * stale, guessable-forever secret in the table indefinitely.
 */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A freshly minted invitation token, and its hash. The plaintext is returned once and never stored. */
export interface MintedInvitationToken {
  readonly token: string;
  readonly tokenHash: string;
}

/** Mint a token. The only source of one — every `create`/`resend` call site goes through this. */
export async function mintInvitationToken(): Promise<MintedInvitationToken> {
  const token = randomToken(TOKEN_BYTES);
  return { token, tokenHash: await hashApiKeySecret(token) };
}

/** Hash a presented token the same way {@link mintInvitationToken} hashed it, for comparison. */
export function hashInvitationToken(token: string): Promise<string> {
  return hashApiKeySecret(token);
}
