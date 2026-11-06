/**
 * `/api/webhooks` — N-3 (issue #250, ADR-SDK-18-N3-250): register, list and remove the endpoints a
 * workspace's run outcomes are posted to. Delivery is `delivery.ts`.
 *
 * Every handler begins with `authorise()` on the `webhooks` resource: Owner and Admin (`MANAGE`),
 * Builder and Viewer refused (ADR D6). An API key acts with its role; a run or browser token is
 * outside its scope. A webhook in another workspace answers the same `404` as an id that never
 * existed. The signing secret appears in no response but the create answer (ADR D1).
 *
 * The list is unpaginated, not cursor-paged: a workspace holds at most ten webhooks
 * (`WEBHOOK_MAX_PER_WORKSPACE`), which the contract's `WebhookListResponseSchema` and spec §5.17
 * fix.
 */
import { isUuid } from '@indx-workspace/contracts';
import {
  CreateWebhookRequestSchema,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_PROBLEM_CODES,
  type CreateWebhookResponse,
  type WebhookEndpoint,
  type WebhookListResponse,
  type WebhookProblemCode,
} from '@indx-workspace/contracts/webhooks';

import { applicationContext } from '../application-context';
import { formatIssues, problem, readJsonBody, type ApiResult } from '../http/result';
import { authorise } from '../rbac/http';
import type { WebhookRecord, WebhooksRuntime } from './runtime';
import { mintWebhookSecret } from './signature';

/** The installed webhook routes, or `null` while they are not serving (their 503). */
function servingWebhooks(): WebhooksRuntime | null {
  const webhooks = applicationContext()?.webhooks;
  return webhooks?.kind === 'serving' ? webhooks.runtime : null;
}

function domainProblem(code: WebhookProblemCode, message: string): ApiResult {
  return problem(WEBHOOK_PROBLEM_CODES[code], code, message);
}

const notConfigured = (): ApiResult =>
  domainProblem(
    'webhook_api_not_configured',
    'This deployment has no secrets service, so a webhook signing secret cannot be stored.',
  );

const webhookNotFound = (id: string): ApiResult =>
  domainProblem('webhook_not_found', `No webhook ${id} in this workspace.`);

function resource(record: WebhookRecord): WebhookEndpoint {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    url: record.url,
    events: [...record.events],
    createdAt: record.createdAt.toISOString(),
  };
}

/** A body the contract refuses: `invalid_webhook_url` when only the URL is wrong (ADR D9). */
function refusedBody(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): ApiResult {
  const details = formatIssues(issues);
  if (issues.length > 0 && issues.every((issue) => issue.path[0] === 'url')) {
    return problem(400, 'invalid_webhook_url', 'The webhook URL is not acceptable.', details);
  }
  return problem(400, 'invalid_body', 'The request body is not a webhook.', details);
}

export async function list(request: Request): Promise<ApiResult> {
  return authorise(request, 'not-applicable', async ({ principal }) => {
    const runtime = servingWebhooks();
    if (runtime === null) return notConfigured();
    const records = await (await runtime.repository(principal.workspaceId)).list();
    const body: WebhookListResponse = { webhooks: records.map(resource) };
    return { status: 200, body };
  });
}

export async function create(request: Request): Promise<ApiResult> {
  return authorise(request, 'not-applicable', async ({ principal }) => {
    const runtime = servingWebhooks();
    if (runtime === null) return notConfigured();
    const raw = await readJsonBody(request);
    if (!raw.ok) return raw.result;
    const parsed = CreateWebhookRequestSchema.safeParse(raw.value);
    if (!parsed.success) return refusedBody(parsed.error.issues);
    const { url } = parsed.data;
    const egress = await runtime.checkUrl(url);
    if (!egress.ok) {
      return domainProblem(
        'webhook_url_refused',
        `The egress policy refuses ${egress.host}: ${egress.reason}`,
      );
    }

    const repository = await runtime.repository(principal.workspaceId);
    const outcome = await repository.create({
      url,
      events: parsed.data.events ?? WEBHOOK_EVENT_TYPES,
    });
    if (outcome.kind === 'limit-reached') {
      return domainProblem(
        'webhook_limit_reached',
        `This workspace already has ${String(outcome.limit)} webhooks; remove one first.`,
      );
    }
    const { webhook } = outcome;
    const secret = mintWebhookSecret();
    try {
      await runtime.secrets.store(webhook.workspaceId, webhook.id, secret);
    } catch (error) {
      // A webhook nobody can verify is worse than none: take the row back out.
      await repository.remove(webhook.id);
      throw error;
    }
    const body: CreateWebhookResponse = { webhook: resource(webhook), secret };
    return { status: 201, body };
  });
}

export async function remove(request: Request, id: unknown): Promise<ApiResult> {
  const webhookId = String(id);
  return authorise(request, 'not-applicable', async ({ principal }) => {
    const runtime = servingWebhooks();
    if (runtime === null) return notConfigured();
    if (!isUuid(webhookId)) {
      return domainProblem(
        'invalid_webhook_id',
        `${JSON.stringify(webhookId)} is not a webhook id.`,
      );
    }
    const repository = await runtime.repository(principal.workspaceId);
    if (!(await repository.remove(webhookId))) return webhookNotFound(webhookId);
    await runtime.secrets.remove(principal.workspaceId, webhookId);
    return { status: 204, body: null };
  });
}
