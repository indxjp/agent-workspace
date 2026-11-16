/**
 * `POST /api/auth/email-link` and `POST /api/auth/email-link/verify` (spec §21, "Guest"): the HTTP
 * edge of the email-link sign-in. Both are pre-session routes, so neither has a tenant session to
 * read; each does its own same-origin check, as `/api/auth/workspace` does, because exemption from
 * the proxy's session gate is also exemption from its origin check.
 *
 * The handlers parse the body with the contracts schemas and hand the use case to
 * {@link EmailLinkService}. Every refusal is the ADR-0075 problem envelope with the status
 * `EMAIL_LINK_PROBLEM_CODES` fixes, and the rate limit carries `Retry-After`. A verified link mints
 * the same session cookie the OIDC callback sets, for the guest's demo workspace, marked
 * `via: 'email_link'` so `/api/auth/workspace` never switches it to another workspace.
 */
import {
  EMAIL_LINK_PROBLEM_CODES,
  EmailLinkRequestSchema,
  EmailLinkVerifyRequestSchema,
  type EmailLinkProblemCode,
} from '@indx-workspace/contracts/email-link';
import { NextResponse } from 'next/server';

import { mintSessionToken, newEmailLinkSessionClaims, sessionCookie } from '../../auth';
import { crossOrigin } from '../../auth/cross-origin';
import type { Clock } from '../../clock';
import { formatIssues, noStoreResultResponse, problem, readJsonBody } from '../../http/result';
import type { EmailLinkService } from '../ports';

/** The bodies are an address and a 43-character secret; anything near this size is not one. */
const MAX_BODY_BYTES = 1024;

/**
 * What the composition root installs as `ApplicationContext.emailLink`. `unavailable` means this
 * deployment wired no email-link sign-in (no database or no session secret); both routes answer
 * `503 email_link_unavailable`.
 */
export type EmailLinkRuntime =
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'ready';
      readonly service: EmailLinkService;
      /** The time a session is minted at. The service reads the same clock for the links. */
      readonly clock: Clock;
    };

const MESSAGES: Readonly<Record<EmailLinkProblemCode, string>> = {
  invalid_body: 'The request body is not valid.',
  email_link_invalid: 'This sign-in link is not valid. Request a new one.',
  email_link_challenge_failed: 'The sign-up check did not pass. Try again.',
  demo_entry_unavailable: 'That demo is not available.',
  email_link_address_refused:
    'This email address cannot be used for the demo. Use another address.',
  email_link_rate_limited: 'Too many requests. Try again later.',
  email_link_unavailable: 'Email sign-in is not available on this deployment.',
};

function refusal(code: EmailLinkProblemCode, details?: readonly string[], retryAfter?: number) {
  const result = problem(EMAIL_LINK_PROBLEM_CODES[code], code, MESSAGES[code], details);
  return noStoreResultResponse(
    retryAfter === undefined
      ? result
      : { ...result, headers: { 'retry-after': String(retryAfter) } },
  );
}

type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly response: Response };

async function readBody<T>(
  request: Request,
  schema: {
    safeParse(input: unknown):
      | { success: true; data: T }
      | {
          success: false;
          error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
        };
  },
): Promise<Parsed<T>> {
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return { ok: false, response: refusal('invalid_body') };
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) {
    return { ok: false, response: refusal('invalid_body', formatIssues(parsed.error.issues)) };
  }
  return { ok: true, value: parsed.data };
}

/** `POST /api/auth/email-link`: send a link. `202 { status: 'sent' }` for every address. */
export async function issueEmailLink(
  request: Request,
  runtime: EmailLinkRuntime | null,
  storeBaseUrl: string | null = null,
): Promise<Response> {
  const blocked = crossOrigin(request, storeBaseUrl);
  if (blocked !== null) return blocked;
  if (runtime === null || runtime.kind === 'unavailable') return refusal('email_link_unavailable');
  const body = await readBody(request, EmailLinkRequestSchema);
  if (!body.ok) return body.response;
  const outcome = await runtime.service.issue({
    email: body.value.email,
    challenge: body.value.challenge,
    ...(body.value.entry === undefined ? {} : { entry: body.value.entry }),
    headers: request.headers,
  });
  if (outcome.kind === 'refused') {
    return refusal(outcome.code, undefined, outcome.retryAfterSeconds);
  }
  return noStoreResultResponse({ status: 202, body: outcome.body });
}

/**
 * `POST /api/auth/email-link/verify`: consume a link. `200` with the session cookie for the
 * guest's demo workspace, or `400 email_link_invalid` for any link that cannot be used.
 */
export async function verifyEmailLink(
  request: Request,
  runtime: EmailLinkRuntime | null,
  sessionSecret: string | null,
  storeBaseUrl: string | null = null,
): Promise<Response> {
  const blocked = crossOrigin(request, storeBaseUrl);
  if (blocked !== null) return blocked;
  if (runtime === null || runtime.kind === 'unavailable' || sessionSecret === null) {
    return refusal('email_link_unavailable');
  }
  const body = await readBody(request, EmailLinkVerifyRequestSchema);
  if (!body.ok) return body.response;
  const outcome = await runtime.service.verify({
    email: body.value.email,
    token: body.value.token,
    ...(body.value.entry === undefined ? {} : { entry: body.value.entry }),
    headers: request.headers,
  });
  if (outcome.kind === 'refused') {
    return refusal(outcome.code, undefined, outcome.retryAfterSeconds);
  }
  const token = await mintSessionToken(
    newEmailLinkSessionClaims(
      outcome.email,
      outcome.binding.workspaceSlug,
      runtime.clock.now().getTime(),
    ),
    sessionSecret,
  );
  const response = NextResponse.json(outcome.body, {
    status: 200,
    headers: { 'cache-control': 'no-store' },
  });
  response.cookies.set(sessionCookie(token));
  return response;
}
