/**
 * The store's three platform routes (internal spec, "The store app and how it reaches the
 * platform"): `POST /api/store/leads`, `GET /api/store/privacy` and `GET /api/demo/allowance`.
 *
 * The lead form is pre-session: it does its own same-origin check (this host, or the store's
 * origin) and answers every refusal in the ADR-0075 envelope with the status
 * `STORE_LEAD_PROBLEM_CODES` fixes. The privacy facts are public. The allowance is answered to a
 * signed-in session only, and only for a demo workspace.
 */
import {
  DEMO_ALLOWANCE_PROBLEM_CODES,
  type DemoAllowance,
  type StorePrivacyFacts,
} from '@indx-workspace/contracts/demo';
import {
  STORE_LEAD_PROBLEM_CODES,
  StoreLeadRequestSchema,
  type StoreLeadProblemCode,
} from '@indx-workspace/contracts/email-link';

import {
  formatIssues,
  noStoreResultResponse,
  problem,
  readJsonBody,
  type ApiResult,
} from '../../../http/result';
import { crossOrigin, type Principal } from '../../../identity';
import type { StoreLeadService } from '../leads';

/** The largest lead body read, in bytes: an address, a message of at most 2000 characters and a small setup. */
export const MAX_BODY_BYTES = 16 * 1024;

/** What the composition root installs as `ApplicationContext.store`. */
export interface StoreRuntime {
  /** `AW_EMAIL_LINK_BASE_URL`: the store's page, whose origin may call these routes; `null` when unset. */
  readonly baseUrl: string | null;
  readonly privacy: StorePrivacyFacts;
  /** `null` where this deployment cannot take a lead (no challenge configured). */
  readonly leads: StoreLeadService | null;
  /** `null` where there is no database to count runs in. */
  readonly allowance: {
    readonly read: (workspaceId: string, userId: string) => Promise<DemoAllowance | null>;
  } | null;
}

const MESSAGES: Readonly<Record<StoreLeadProblemCode, string>> = {
  invalid_body: 'The request body is not valid.',
  store_lead_challenge_failed: 'The sign-up check did not pass. Try again.',
  store_lead_rate_limited: 'Too many requests. Try again later.',
  store_lead_unavailable: 'The enquiry form is not available on this deployment.',
};

function refusal(code: StoreLeadProblemCode, details?: readonly string[], retryAfter?: number) {
  const result = problem(STORE_LEAD_PROBLEM_CODES[code], code, MESSAGES[code], details);
  return noStoreResultResponse(
    retryAfter === undefined
      ? result
      : { ...result, headers: { 'retry-after': String(retryAfter) } },
  );
}

/** `POST /api/store/leads`: `202 { status: 'received' }` for a kept, a known and a blocked address. */
export async function postStoreLead(
  request: Request,
  runtime: StoreRuntime | null,
): Promise<Response> {
  const blocked = crossOrigin(request, runtime?.baseUrl ?? null);
  if (blocked !== null) return blocked;
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return refusal('invalid_body');
  const parsed = StoreLeadRequestSchema.safeParse(body.value);
  if (!parsed.success) return refusal('invalid_body', formatIssues(parsed.error.issues));
  if (runtime === null || runtime.leads === null) return refusal('store_lead_unavailable');
  const outcome = await runtime.leads.submit(parsed.data, request.headers);
  if (outcome.kind === 'refused')
    return refusal(outcome.code, undefined, outcome.retryAfterSeconds);
  return noStoreResultResponse({ status: 202, body: { status: 'received' } });
}

/** `GET /api/store/privacy`: the facts only this deployment's configuration knows. */
export function getStorePrivacy(runtime: StoreRuntime | null): Response {
  if (runtime === null) {
    return noStoreResultResponse(
      problem(503, 'service_unavailable', 'This deployment is not configured.'),
    );
  }
  return noStoreResultResponse({ status: 200, body: runtime.privacy });
}

/**
 * `GET /api/demo/allowance` for the caller `principal` (authorised as reading its own `me`, which
 * every role may). A workspace that is not a demo workspace is `404 demo_workspace_not_found`,
 * whoever asks.
 */
export async function demoAllowanceOf(
  principal: Pick<Principal, 'workspaceId' | 'userId'>,
  runtime: StoreRuntime | null,
): Promise<ApiResult> {
  const allowance =
    principal.userId === null || runtime?.allowance == null
      ? null
      : await runtime.allowance.read(principal.workspaceId, principal.userId);
  if (allowance === null) {
    return problem(
      DEMO_ALLOWANCE_PROBLEM_CODES.demo_workspace_not_found,
      'demo_workspace_not_found',
      'This workspace is not a demo workspace.',
    );
  }
  return { status: 200, body: allowance };
}
