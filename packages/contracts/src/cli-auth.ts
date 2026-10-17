import { z } from 'zod';

import { IsoDateTimeSchema } from './identifiers.js';
import { WorkspaceMembershipViewSchema } from './workspaces.js';

/**
 * Issue #242 (SDK-10, S-22): `aw login` signs a person in with an OAuth 2.0 device authorization
 * grant (RFC 8628) and holds a short-lived user token. ADR-0083.
 *
 * `awu_live_` — distinct from `ak_live_` (an API key) and `awt_live_` (a browser token) — is what
 * lets `apps/web/proxy.ts` recognise the credential by shape without verifying it.
 */
export const CLI_TOKEN_PREFIX = 'awu_live_';

/** Same anchored fixed-length halves as an API key: 16 bytes / 32 bytes, base64url. */
export const CLI_TOKEN_PATTERN = /^awu_live_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/u;

/** A token lives twelve hours — one working day, the browser session's own lifetime — then `aw login` again. */
export const CLI_TOKEN_TTL_SECONDS = 12 * 60 * 60;

/** How long a device code may wait for the person to approve it (RFC 8628 §3.2 `expires_in`). */
export const CLI_DEVICE_CODE_TTL_SECONDS = 10 * 60;

/** The minimum seconds between two polls (RFC 8628 §3.2 `interval`). */
export const CLI_POLL_INTERVAL_SECONDS = 5;

/**
 * The code the person types, as it is shown: `WXYZ-BCDF`. Consonants only (RFC 8628 §6.1's
 * recommendation), so it spells nothing and survives being read aloud; case and the dash are
 * forgiven on input.
 */
export const CLI_USER_CODE_PATTERN = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u;

/** The page, on the control plane's own origin, where the person approves a user code. */
export const CLI_VERIFICATION_PATH = '/api/auth/cli-verify';

/** The `200` of `POST /api/auth/cli-device`. `deviceCode` is secret to the CLI that asked for it. */
export const DeviceAuthorizationResponseSchema = z
  .object({
    deviceCode: z.string().min(1).max(1024),
    userCode: z.string().regex(CLI_USER_CODE_PATTERN),
    /** Relative to the control plane URL the CLI already trusts; never an absolute URL. */
    verificationPath: z.literal(CLI_VERIFICATION_PATH),
    expiresInSeconds: z.number().int().positive(),
    intervalSeconds: z.number().int().positive(),
  })
  .strict()
  .readonly();

export type DeviceAuthorizationResponse = z.infer<typeof DeviceAuthorizationResponseSchema>;

/** The body of `POST /api/auth/cli-token`: the device code, in the body and never in a URL. */
export const CliTokenRequestSchema = z
  .object({ deviceCode: z.string().min(1).max(1024) })
  .strict()
  .readonly();

export type CliTokenRequest = z.infer<typeof CliTokenRequestSchema>;

/**
 * The `200` of `POST /api/auth/cli-token` once the person approved: the token, its expiry, and
 * the workspace it acts in. The only response body besides an API key's and a browser token's
 * that carries a bearer credential's plaintext.
 */
export const CliTokenResponseSchema = z
  .object({
    token: z.string().regex(CLI_TOKEN_PATTERN),
    expiresAt: IsoDateTimeSchema,
    workspace: WorkspaceMembershipViewSchema,
  })
  .strict()
  .readonly();

export type CliTokenResponse = z.infer<typeof CliTokenResponseSchema>;

/**
 * The codes `POST /api/auth/cli-token` answers `400` with while no token is issued — RFC 8628
 * §3.5's error names. `authorization_pending` and `slow_down` mean "poll again"; the other three
 * end the sign-in.
 */
export const CLI_TOKEN_POLL_CODES = [
  'authorization_pending',
  'slow_down',
  'access_denied',
  'expired_token',
  'invalid_grant',
] as const;

export type CliTokenPollCode = (typeof CLI_TOKEN_POLL_CODES)[number];
