/**
 * `/api/auth/cli-*` — issue #242 (SDK-10, S-22): `aw login` signs a person in with an OAuth 2.0
 * device authorization grant (RFC 8628) and holds a short-lived, revocable user token. ADR-0083.
 *
 * Framework-free, like `apps/web/server/tokens/handlers.ts`: every function takes a `Request`
 * (or plain data) and returns an {@link ApiResult}; the route files are thin adapters.
 *
 * The four JSON routes and what proves the caller:
 *
 *   * `POST /api/auth/cli-device` — nobody yet. Answers a signed device code and a user code. No
 *     row is written; the per-client limit (`./rate-limit.ts`) bounds how fast codes are minted.
 *   * `POST /api/auth/cli-token` — possession of that device code. Answers RFC 8628 §3.5's errors
 *     until the person approves, then the token, exactly once.
 *   * `DELETE /api/auth/cli-token` — possession of the token. Revokes it server-side.
 *   * `POST /api/auth/cli-workspace` — the token, verified by the same `identify()` every route
 *     uses. Moves it to another of the person's memberships.
 *
 * The approval itself (`/api/auth/cli-verify`) is in `./verify-page.ts`.
 *
 * No function here logs, audits or echoes a token, a token hash or a device code.
 */
import {
  CLI_DEVICE_CODE_TTL_SECONDS,
  CLI_POLL_INTERVAL_SECONDS,
  CLI_TOKEN_TTL_SECONDS,
  CLI_VERIFICATION_PATH,
  CliTokenRequestSchema,
  type CliTokenPollCode,
  type CliTokenResponse,
  type DeviceAuthorizationResponse,
} from '@indx-workspace/contracts/cli-auth';
import { WorkspaceSwitchRequestSchema } from '@indx-workspace/contracts/workspaces';

import { BoundedRecencyMap } from '../http/rate-limit';
import { hashCliTokenSecret, mintCliToken, readBearerCliTokenAttempt } from '../rbac/cli-token';
import { problem, readJsonBody, type ApiResult } from '../rbac/http';
import { currentRbacRuntime } from '../rbac/runtime';
import { getWorkspace, serialiseMembershipView } from '../workspaces/handlers';
import { currentWorkspacesRuntime } from '../workspaces/runtime';
import { displayUserCode, mintDeviceCode, newUserCode, verifyDeviceCode } from './device-code';
import { admitCliAuthRequest, resetCliAuthRateLimits, type CliAuthRoute } from './rate-limit';
import { currentCliAuthRuntime } from './runtime';

const notConfigured = (): ApiResult =>
  problem(503, 'cli_auth_not_configured', 'CLI sign-in is not configured on this deployment.');

const pollProblem = (code: CliTokenPollCode, message: string): ApiResult =>
  problem(400, code, message);

/**
 * RFC 8628 §3.5's `slow_down`, per device, per process. Best effort by design: the poll it
 * throttles is one indexed read, and a second replica merely lets the CLI poll twice as often.
 * Bounded without a sweep (review round 1): at capacity the least recently polled code is
 * forgotten in O(1), so a flood of fresh device codes costs memory up to the cap and no more —
 * and the per-client limit in `./rate-limit.ts` caps how fast anyone can mint them.
 */
const POLL_MEMORY_LIMIT = 10_000;
const lastPollMs = new BoundedRecencyMap<number>(POLL_MEMORY_LIMIT);

function pollTooSoon(userCode: string, nowMs: number): boolean {
  const previous = lastPollMs.get(userCode);
  lastPollMs.set(userCode, nowMs);
  return previous !== undefined && nowMs - previous < CLI_POLL_INTERVAL_SECONDS * 1000;
}

/** How many device codes the `slow_down` memory holds right now. Tests only. */
export function cliPollMemorySize(): number {
  return lastPollMs.size;
}

/** Forget every remembered poll and every client's request count. Tests only. */
export function resetCliPollMemory(): void {
  lastPollMs.clear();
  resetCliAuthRateLimits();
}

/** `429 rate_limited` with `Retry-After`, or `null` when the client is admitted. */
export function refuseOverLimit(
  route: CliAuthRoute,
  request: Request,
  nowMs: number,
): ApiResult | null {
  const admission = admitCliAuthRequest(route, request.headers, nowMs);
  if (admission.admitted) return null;
  return {
    ...problem(429, 'rate_limited', 'Too many sign-in requests from this client; retry later.'),
    headers: { 'retry-after': String(admission.retryAfterSeconds) },
  };
}

/** `POST /api/auth/cli-device` — start a sign-in. */
export function startDeviceAuthorization(request: Request, nowMs: number = Date.now()): ApiResult {
  const runtime = currentCliAuthRuntime();
  if (runtime === null) return notConfigured();
  const limited = refuseOverLimit('start', request, nowMs);
  if (limited !== null) return limited;
  const userCode = newUserCode();
  const expiresAt = Math.floor(nowMs / 1000) + CLI_DEVICE_CODE_TTL_SECONDS;
  const body: DeviceAuthorizationResponse = {
    deviceCode: mintDeviceCode(userCode, expiresAt, runtime.secret),
    userCode: displayUserCode(userCode),
    verificationPath: CLI_VERIFICATION_PATH,
    expiresInSeconds: CLI_DEVICE_CODE_TTL_SECONDS,
    intervalSeconds: CLI_POLL_INTERVAL_SECONDS,
  };
  return { status: 200, body };
}

/** `POST /api/auth/cli-token` — poll; the token once the person approved. */
export async function exchangeDeviceCode(
  request: Request,
  nowMs: number = Date.now(),
): Promise<ApiResult> {
  const runtime = currentCliAuthRuntime();
  const workspaces = currentWorkspacesRuntime();
  if (runtime === null || workspaces === null) return notConfigured();
  const limited = refuseOverLimit('poll', request, nowMs);
  if (limited !== null) return limited;
  const raw = await readJsonBody(request);
  if (!raw.ok) return raw.result;
  const parsed = CliTokenRequestSchema.safeParse(raw.value);
  if (!parsed.success) {
    return problem(400, 'invalid_request', 'The body must be { deviceCode: string }.');
  }
  const verified = verifyDeviceCode(parsed.data.deviceCode, runtime.secret, nowMs / 1000);
  if (!verified.ok) {
    return verified.reason === 'expired'
      ? pollProblem('expired_token', 'The device code expired. Run `aw login` again.')
      : pollProblem('invalid_grant', 'That is not a device code this server issued.');
  }
  if (pollTooSoon(verified.userCode, nowMs)) {
    return pollProblem('slow_down', 'Polling too fast; wait the interval before polling again.');
  }
  const minted = await mintCliToken();
  const expiresAt = new Date(nowMs + CLI_TOKEN_TTL_SECONDS * 1000);
  const outcome = await runtime.sessions.exchange(
    verified.userCode,
    minted.tokenHash,
    expiresAt,
    new Date(nowMs),
  );
  switch (outcome.kind) {
    case 'pending':
      return pollProblem('authorization_pending', 'The code has not been approved yet.');
    case 'denied':
      return pollProblem('access_denied', 'The sign-in was denied in the browser.');
    case 'expired':
      return pollProblem('expired_token', 'The approval expired. Run `aw login` again.');
    case 'spent':
      return pollProblem('invalid_grant', 'This device code has already been exchanged.');
    case 'issued': {
      const view = await workspaces.repository.getForMember(outcome.workspaceId, outcome.userId);
      if (view === null) {
        // The membership vanished between approval and exchange: the token must not outlive it.
        await runtime.sessions.revokeByHash(minted.tokenHash, new Date(nowMs));
        return pollProblem('access_denied', 'The approving membership no longer exists.');
      }
      const body: CliTokenResponse = {
        token: minted.presented,
        expiresAt: expiresAt.toISOString(),
        workspace: serialiseMembershipView(view),
      };
      return { status: 200, body };
    }
    default: {
      const unreachable: never = outcome;
      throw new Error(`unclassified exchange outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

const invalidBearer = (): ApiResult =>
  problem(401, 'unauthenticated', 'This route requires the token `aw login` holds.');

/** `DELETE /api/auth/cli-token` — sign out: revoke the presented token server-side. */
export async function revokeCliToken(
  request: Request,
  nowMs: number = Date.now(),
): Promise<ApiResult> {
  const runtime = currentCliAuthRuntime();
  if (runtime === null) return notConfigured();
  const attempt = readBearerCliTokenAttempt(request.headers.get('authorization'));
  if (attempt.kind !== 'presented') return invalidBearer();
  const revoked = await runtime.sessions.revokeByHash(
    await hashCliTokenSecret(attempt.token.secret),
    new Date(nowMs),
  );
  return revoked ? { status: 204, body: null } : invalidBearer();
}

const workspaceNotAvailable = (): ApiResult =>
  problem(404, 'workspace_not_available', 'That is not one of your current workspaces.');

/** `POST /api/auth/cli-workspace` — move the presented token to another of the person's workspaces. */
export async function switchCliWorkspace(
  request: Request,
  nowMs: number = Date.now(),
): Promise<ApiResult> {
  const runtime = currentCliAuthRuntime();
  const rbac = currentRbacRuntime();
  const workspaces = currentWorkspacesRuntime();
  if (runtime === null || rbac === null || workspaces === null) return notConfigured();
  const principal = await rbac.identify(request);
  const attempt = readBearerCliTokenAttempt(request.headers.get('authorization'));
  if (
    principal?.via !== 'user-token' ||
    principal.userId === null ||
    attempt.kind !== 'presented'
  ) {
    return invalidBearer();
  }
  const raw = await readJsonBody(request);
  if (!raw.ok) return raw.result;
  const parsed = WorkspaceSwitchRequestSchema.safeParse(raw.value);
  if (!parsed.success) {
    return problem(400, 'malformed_request', 'The request body must be { workspace: string }.');
  }
  const requested = parsed.data.workspace;
  // Re-read now: a membership removed since sign-in must not be honoured.
  const memberships = await rbac.directory.membershipsForUser(principal.userId);
  const match = memberships.find(
    (candidate) => candidate.workspaceId === requested || candidate.workspaceSlug === requested,
  );
  if (match === undefined) return workspaceNotAvailable();
  const moved = await runtime.sessions.moveToWorkspace(
    await hashCliTokenSecret(attempt.token.secret),
    match.workspaceId,
    new Date(nowMs),
  );
  if (!moved) return workspaceNotAvailable();
  const view = await getWorkspace(workspaces.repository, match.workspaceId, principal.userId);
  return view.status === 200 ? view : workspaceNotAvailable();
}
