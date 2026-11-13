/**
 * `POST /api/triggers/:id/fire/:secret` — issue #1293, ADR-0144: the public ingress that turns a
 * webhook into a run. The secret in the path is the whole authentication, because Microsoft Graph
 * and Zoom call a fixed URL and send no header.
 *
 * The order is the design:
 *
 * 1. The secret is checked first, in constant time and against a dummy hash when the trigger or its
 *    hash is missing. An unknown id, a wrong secret, a disabled trigger and a schedule trigger all
 *    answer the one `404`, so a caller learns nothing about which triggers exist.
 * 2. The owner is re-read and re-checked with RBAC: a trigger acts as its owner and never as more
 *    than the owner may do today (`403`, after the secret has proved the caller may ask).
 * 3. A Graph `validationToken` is echoed and a Zoom `endpoint.url_validation` is answered; neither
 *    claims a delivery nor starts a run.
 * 4. The body is read within 256 KiB, the delivery is claimed under the `Idempotency-Key` (a repeat
 *    returns the first run; without the header, under a digest of the body, so a Graph or Zoom
 *    redelivery of the same notification dedupes), the rate and concurrency limits are counted from `trigger_deliveries`,
 *    and only then is a run started, in a new session, as the owner.
 *
 * A refused or failed start releases its claim so the sender can retry with the same key; a started
 * run keeps it, so a retry never starts a second run.
 */
import { createHash, createHmac } from 'node:crypto';

import { isUuid } from '@indx-workspace/contracts';
import {
  renderTriggerPrompt,
  TRIGGER_IDEMPOTENCY_KEY_MAX_LENGTH,
  TRIGGER_MAX_BODY_BYTES,
  TRIGGER_MAX_CONCURRENT_RUNS,
  TRIGGER_PROBLEM_CODES,
  TRIGGER_RATE_PER_MINUTE,
  TRIGGER_VALIDATION_TOKEN_MAX_LENGTH,
  type TriggerProblemCode,
  ZoomUrlValidationEventSchema,
} from '@indx-workspace/contracts/triggers';

import { readCappedBody } from '../endpoints/request';
import { featureRefusalResponse } from '../features/guard';
import { noStoreResultResponse, problemWithDetail as problem } from '../http/result';
import { clientSecretDigest, decide, hashesEqual, type Principal } from '../identity';
import { randomIds, type IdGenerator } from '../ids';
import { log } from '../telemetry/logger';
import type { RunRecord } from '../execution';
import { getRunApi } from '../runs/environment';
import { renderRun } from '../runs/api';
import { MAX_PROMPT_CHARS, startRunOnSession } from '../runs/service';
import { domainProblem, servingTriggers } from './handlers';
import type { TriggersRuntime } from './runtime';

// Delivery: claim a firing under its idempotency key, apply the rate and concurrency limits and
// start the run as the trigger's owner. Shared with the schedule pass, so both obey the same limits.
const RATE_WINDOW_MS = 60_000;

export type Runtime = TriggersRuntime;
export type Runs = NonNullable<ReturnType<typeof getRunApi>>;
export type Trigger = NonNullable<Awaited<ReturnType<Runtime['findForIngress']>>>['trigger'];

export type DeliveryOutcome =
  | { readonly kind: 'started'; readonly run: RunRecord }
  | { readonly kind: 'duplicate'; readonly runId: string | null }
  | { readonly kind: 'not-found' }
  | {
      readonly kind: 'refused';
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly retryAfterSeconds?: number;
    };

const refusal = (
  code: TriggerProblemCode,
  message: string,
  retryAfterSeconds?: number,
): DeliveryOutcome => ({
  kind: 'refused',
  status: TRIGGER_PROBLEM_CODES[code],
  code,
  message,
  ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
});

type DeliveryRepository = Awaited<ReturnType<Runtime['repository']>>;
type DeliveryRequest = { trigger: Trigger; owner: Principal; prompt: string; key: string };

const RATE_LIMIT_RETRY_SECONDS = 60;
const CONCURRENCY_LIMIT_RETRY_SECONDS = 30;

/**
 * A refusal when the trigger is over its rate or concurrency limit (the claim is released), else
 * `null`. ponytail: counted, not locked, so a burst can exceed a limit by the requests in flight;
 * lock the trigger row if that matters.
 */
async function refuseOverLimits(
  repository: DeliveryRepository,
  runtime: Runtime,
  { trigger, key }: DeliveryRequest,
): Promise<DeliveryOutcome | null> {
  const windowStart = new Date(runtime.now().getTime() - RATE_WINDOW_MS);
  if ((await repository.countDeliveriesSince(trigger.id, windowStart)) > TRIGGER_RATE_PER_MINUTE) {
    await repository.releaseDelivery(trigger.id, key);
    return refusal(
      'trigger_rate_limited',
      `this trigger accepts ${String(TRIGGER_RATE_PER_MINUTE)} firings a minute.`,
      RATE_LIMIT_RETRY_SECONDS,
    );
  }
  if ((await repository.countUnfinishedRuns(trigger.id)) >= TRIGGER_MAX_CONCURRENT_RUNS) {
    await repository.releaseDelivery(trigger.id, key);
    return refusal(
      'trigger_concurrency_limited',
      `this trigger has ${String(TRIGGER_MAX_CONCURRENT_RUNS)} runs unfinished; retry when one ends.`,
      CONCURRENCY_LIMIT_RETRY_SECONDS,
    );
  }
  return null;
}

/** Start the trigger's run as its owner; `null` when the agent can no longer be found. */
async function startOwnerRun(runs: Runs, { trigger, owner, prompt }: DeliveryRequest) {
  const agent = await runs.findAgent(owner, trigger.agentId);
  if (agent === null) return null;
  return startRunOnSession(runs, owner, agent, {
    prompt,
    sessionId: null,
    modelOverride: null,
    ...(trigger.outputSchema === null ? {} : { outputSchema: trigger.outputSchema }),
    ...(trigger.subject === null ? {} : { subject: trigger.subject }),
  });
}

/**
 * Free the claim after a failure before any run started. A failed release leaves the claim at
 * run_id null until its window lapses; say so, and still surface the original failure.
 */
async function releaseAfterFailure(
  repository: DeliveryRepository,
  { trigger, key }: DeliveryRequest,
  failure: unknown,
): Promise<void> {
  await repository.releaseDelivery(trigger.id, key).catch((releaseError: unknown) => {
    log.error(`[trigger] ${trigger.id} could not release its delivery claim`, {
      error: releaseError,
      cause: failure,
    });
    return false;
  });
}

/**
 * Claim the delivery, apply the limits, start the run; a refusal or failure frees the claim. Shared by
 * the webhook ingress and the schedule pass, so both obey the same limits and the same ownership.
 */
export async function deliver(
  runtime: Runtime,
  runs: Runs,
  delivery: DeliveryRequest,
): Promise<DeliveryOutcome> {
  const { trigger, key } = delivery;
  const repository = await runtime.repository(trigger.workspaceId);
  const claim = await repository.claimDelivery(trigger.id, key, runtime.now());
  if (claim.kind === 'trigger-not-found') return { kind: 'not-found' };
  if (claim.kind === 'duplicate') return { kind: 'duplicate', runId: claim.runId };

  // Once a run has started the claim stays, even if recording it fails: a retry with the same key
  // then answers `409` instead of starting a second run.
  let runStarted = false;
  try {
    const overLimit = await refuseOverLimits(repository, runtime, delivery);
    if (overLimit !== null) return overLimit;

    const started = await startOwnerRun(runs, delivery);
    if (started === null || started.kind === 'refused') {
      await repository.releaseDelivery(trigger.id, key);
      return started === null
        ? refusal('trigger_owner_not_allowed', 'the trigger’s agent can no longer be run.')
        : { kind: 'refused', status: started.status, code: started.code, message: started.message };
    }
    // ponytail: one failed recordDeliveryRun leaves the delivery at run_id null, so a retry with the
    // same key answers 409 for the dedupe window and the run is not counted toward the concurrency
    // limit; retry the write if that matters.
    runStarted = true;
    await repository.recordDeliveryRun(trigger.id, key, started.run.id);
    await repository.markFired(trigger.id, runtime.now());
    return { kind: 'started', run: started.run };
  } catch (error) {
    if (!runStarted) await releaseAfterFailure(repository, delivery, error);
    throw error;
  }
}

const DUMMY_HASH = '0'.repeat(64);

const reply = (result: ReturnType<typeof problem>): Response => noStoreResultResponse(result);

/** The one answer for every miss. */
const notFound = (): Response =>
  reply(domainProblem('trigger_not_found', 'no such trigger, or the secret is wrong.'));

const retryLater = (result: ReturnType<typeof problem>, seconds: number): Response =>
  reply({ ...result, headers: { 'retry-after': String(seconds) } });

/** The enabled webhook trigger whose secret this is, or `null` for every kind of miss. */
async function authenticated(
  runtime: Runtime,
  id: unknown,
  secret: unknown,
): Promise<Trigger | null> {
  const found = typeof id === 'string' && isUuid(id) ? await runtime.findForIngress(id) : null;
  const digest = await clientSecretDigest(secret);
  const matches = hashesEqual(digest ?? '', found?.secretHash ?? DUMMY_HASH);
  if (
    found === null ||
    found.secretHash === null ||
    digest === null ||
    !matches ||
    !found.trigger.enabled ||
    found.trigger.kind !== 'webhook'
  ) {
    return null;
  }
  return found.trigger;
}

/** The owner as a principal, or `null` when it is gone or may no longer run the agent. */
export async function ownerFor(runtime: Runtime, trigger: Trigger): Promise<Principal | null> {
  const owner = await runtime.owner(trigger.workspaceId, trigger.ownerPrincipalId);
  const ownership =
    owner === null ? 'unknown' : await runtime.agentOwnership(owner, trigger.agentId);
  const allowed =
    owner !== null &&
    ownership !== 'unknown' &&
    decide({
      role: owner.role,
      method: 'POST',
      path: `/api/agents/${trigger.agentId}/runs`,
      ownership,
      scope: null,
    }).effect === 'allow';
  return allowed ? owner : null;
}

const ownerNotAllowed = (): Response =>
  reply(
    domainProblem(
      'trigger_owner_not_allowed',
      'the owner of this trigger no longer exists or may no longer run its agent.',
    ),
  );

function graphHandshake(token: string): Response {
  if (token.length > TRIGGER_VALIDATION_TOKEN_MAX_LENGTH) {
    return reply(problem(400, 'invalid_field', 'validationToken is too long.'));
  }
  return new Response(token, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function zoomHandshake(runtime: Runtime, trigger: Trigger, plain: string): Promise<Response> {
  const token = await runtime.zoomTokens?.read(trigger.workspaceId, trigger.id);
  if (token === undefined || token === null) {
    return reply(
      domainProblem(
        'trigger_zoom_not_configured',
        'this trigger has no Zoom secret token; set zoomSecretToken to answer Zoom URL validation.',
      ),
    );
  }
  return noStoreResultResponse({
    status: 200,
    body: {
      plainToken: plain,
      encryptedToken: createHmac('sha256', token).update(plain).digest('hex'),
    },
  });
}

export async function fire(request: Request, id: unknown, secret: unknown): Promise<Response> {
  const runtime = servingTriggers();
  const runs = getRunApi();
  if (runtime === null || runs === null) {
    return reply(problem(503, 'triggers_not_configured', 'Triggers are not configured.'));
  }
  const trigger = await authenticated(runtime, id, secret);
  if (trigger === null) return notFound();
  // ADR-0160 D7: the secret matched, so the workspace is the trigger row's own; nothing else is read yet.
  const disabled = await featureRefusalResponse(request, trigger.workspaceId);
  if (disabled !== null) return disabled;
  const owner = await ownerFor(runtime, trigger);
  if (owner === null) return ownerNotAllowed();

  const validationToken = new URL(request.url).searchParams.get('validationToken');
  if (validationToken !== null) return graphHandshake(validationToken);

  const body = await readCappedBody(request, TRIGGER_MAX_BODY_BYTES);
  if (body.kind === 'too_large') {
    return reply(
      domainProblem(
        'trigger_body_too_large',
        `the request body exceeds ${String(TRIGGER_MAX_BODY_BYTES)} bytes.`,
      ),
    );
  }
  if (body.kind === 'unreadable') {
    return reply(problem(400, 'malformed_body', 'The request body could not be read.'));
  }
  const zoom = zoomValidation(body.text);
  if (zoom !== null) return zoomHandshake(runtime, trigger, zoom);

  const prompt = renderTriggerPrompt(trigger.promptTemplate, body.text);
  if (prompt.length > MAX_PROMPT_CHARS) {
    return reply(
      domainProblem(
        'trigger_prompt_too_long',
        `the prompt with the body substituted exceeds ${String(MAX_PROMPT_CHARS)} characters.`,
      ),
    );
  }
  const key = deliveryKey(
    request.headers.get('idempotency-key'),
    body.text,
    runtime.ids ?? randomIds,
  );
  if (key === '' || key.length > TRIGGER_IDEMPOTENCY_KEY_MAX_LENGTH) {
    return reply(
      domainProblem(
        'trigger_idempotency_key_invalid',
        `Idempotency-Key must be 1 to ${String(TRIGGER_IDEMPOTENCY_KEY_MAX_LENGTH)} characters.`,
      ),
    );
  }
  return deliveryResponse(runs, await deliver(runtime, runs, { trigger, owner, prompt, key }));
}

async function deliveryResponse(runs: Runs, outcome: DeliveryOutcome): Promise<Response> {
  switch (outcome.kind) {
    case 'started':
      return noStoreResultResponse({ status: 202, body: { run: renderRun(outcome.run) } });
    case 'not-found':
      return notFound();
    case 'duplicate': {
      const first = outcome.runId === null ? null : await runs.store.get(outcome.runId);
      if (first === null) {
        return retryLater(
          domainProblem(
            'trigger_delivery_in_progress',
            'a delivery with this Idempotency-Key is still starting; retry shortly.',
          ),
          1,
        );
      }
      return noStoreResultResponse({ status: 202, body: { run: renderRun(first) } });
    }
    case 'refused': {
      const result = problem(outcome.status, outcome.code, outcome.message);
      return outcome.retryAfterSeconds === undefined
        ? reply(result)
        : retryLater(result, outcome.retryAfterSeconds);
    }
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled delivery outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The explicit `Idempotency-Key`, else `body:<SHA-256 hex>` so a sender that retries the same body
 * without the header (Graph and Zoom never send one) starts one run. An empty body carries nothing to
 * tell a retry from a new firing, so it gets a fresh key.
 */
function deliveryKey(header: string | null, body: string, ids: IdGenerator): string {
  if (header !== null) return header.trim();
  if (body === '') return `auto:${ids.newId()}`;
  return `body:${createHash('sha256').update(body).digest('hex')}`;
}

/** The `plainToken` of a Zoom `endpoint.url_validation` body, or `null` for any other body. */
function zoomValidation(text: string): string | null {
  if (!text.includes('endpoint.url_validation')) return null;
  try {
    const parsed = ZoomUrlValidationEventSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.payload.plainToken : null;
  } catch {
    return null;
  }
}
