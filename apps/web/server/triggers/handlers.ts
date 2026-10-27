/**
 * `/api/triggers` — issue #1293, ADR-0144: manage the inbound triggers of a workspace. The public
 * fire route is `fire.ts`.
 *
 * Every handler begins with `authorise()`. A route with an `:id` resolves the trigger first, so a
 * trigger in another workspace answers the same `404` as an id that never existed. A trigger's URL
 * secret and its Zoom secret token appear in no response but the one that created them: the secret
 * in `create` and `rotateSecret`'s `201`, the Zoom token nowhere.
 */
import { isUuid } from '@indx-workspace/contracts';
import {
  CreateTriggerRequestSchema,
  TRIGGER_BODY_PLACEHOLDER,
  TRIGGER_PROBLEM_CODES,
  UpdateTriggerRequestSchema,
  type TriggerProblemCode,
  type TriggerResource,
} from '@indx-workspace/contracts/triggers';
import type { ZodError } from 'zod';

import { problemWithDetail as problem, readJsonBody, type ApiResult } from '../http/result';
import { mintClientSecret } from '../oauth/tokens';
import { decide } from '../rbac/decide';
import { authorise, type OwnershipResolver } from '../rbac/http';
import type { Principal } from '../rbac/principal';
import { applicationContext } from '../application-context';
import type { TriggerRecord, TriggersRuntime, ZoomSecretTokens } from './runtime';
import { findScheduleError } from './schedule';

/** The installed trigger routes, or `null` while they are not serving (their 503). */
export function servingTriggers(): TriggersRuntime | null {
  const triggers = applicationContext()?.triggers;
  return triggers?.kind === 'serving' ? triggers.runtime : null;
}

const notConfigured = (): ApiResult =>
  problem(503, 'triggers_runtime_not_configured', 'The trigger routes have no runtime installed.');

export function domainProblem(code: TriggerProblemCode, detail: string): ApiResult {
  return problem(TRIGGER_PROBLEM_CODES[code], code, detail);
}

/** One answer for a trigger that is absent, in another workspace, or not an id at all. */
const triggerNotFound = (id: string): ApiResult =>
  domainProblem('trigger_not_found', `no trigger ${id} in this workspace.`);

function invalidField(error: ZodError): ApiResult {
  return problem(
    400,
    'invalid_field',
    error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '$'}: ${issue.message}`)
      .join('; '),
  );
}

/** A trigger acts for the member that created it, so that member's owner principal owns it. */
function ownershipOfTrigger(id: string): OwnershipResolver {
  return async (principal: Principal) => {
    const runtime = servingTriggers();
    if (runtime === null) return { kind: 'refuse', result: notConfigured() };
    if (!isUuid(id)) return { kind: 'refuse', result: triggerNotFound(id) };
    const trigger = await (await runtime.repository(principal.workspaceId)).get(id);
    if (trigger === null) return { kind: 'refuse', result: triggerNotFound(id) };
    return {
      kind: 'ownership',
      ownership: trigger.ownerPrincipalId === principal.ownerPrincipalId ? 'own' : 'other',
    };
  };
}

/** Whether `principal` could itself start a run on `agentId`; an unknown agent is refused for all. */
async function mayRunAgent(
  runtime: TriggersRuntime,
  principal: Principal,
  agentId: string,
): Promise<boolean> {
  const ownership = await runtime.agentOwnership(principal, agentId);
  const decision = decide({
    role: principal.role,
    method: 'POST',
    path: `/api/agents/${agentId}/runs`,
    ownership,
    scope: null,
  });
  return ownership !== 'unknown' && decision.effect === 'allow';
}

const agentNotRunnable = (agentId: string): ApiResult =>
  domainProblem(
    'trigger_agent_not_runnable',
    `agent ${agentId} does not exist in this workspace or you may not run it, so a trigger cannot start it.`,
  );

/**
 * Whether `principal` may make a trigger's runs act for a `subject` (ADR-0156). A subject is
 * signed as an `api-key` caller, and under ADR-0142 only an API key asserts one, so it takes the
 * same decision as minting a key: `POST /api/api-keys`.
 */
function mayAssertSubject(principal: Principal): boolean {
  return (
    decide({
      role: principal.role,
      method: 'POST',
      path: '/api/api-keys',
      ownership: 'not-applicable',
      scope: principal.scope,
    }).effect === 'allow'
  );
}

const subjectNotAllowed = (): ApiResult =>
  domainProblem(
    'trigger_subject_not_allowed',
    'only a member who may create API keys may set a trigger subject or change a trigger that has one; anyone who may edit the trigger may clear it with "subject": null.',
  );

const apiKeyRefusal = (): ApiResult =>
  problem(
    403,
    'api_key_not_permitted',
    'An API key cannot create a trigger or rotate its secret; a trigger runs as the member that created it. Use a session.',
  );

const zoomUnavailable = (): ApiResult =>
  domainProblem(
    'trigger_zoom_not_configured',
    'this deployment has no secrets service, so a Zoom secret token cannot be stored.',
  );

function resource(record: TriggerRecord, hasZoomSecretToken: boolean): TriggerResource {
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    agentId: record.agentId,
    prompt: record.promptTemplate,
    cron: record.cron,
    timezone: record.timezone,
    enabled: record.enabled,
    outputSchema: record.outputSchema,
    subject: record.subject,
    ownerPrincipalId: record.ownerPrincipalId,
    hasSecret: record.hasSecret,
    hasZoomSecretToken,
    lastFiredAt: record.lastFiredAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function hasZoomToken(
  zoom: ZoomSecretTokens | null,
  record: TriggerRecord,
): Promise<boolean> {
  if (zoom === null) return false;
  return (await zoom.configured(record.workspaceId, [record.id])).has(record.id);
}

function secretBody(trigger: TriggerResource, secret: string, headline: string) {
  return {
    trigger,
    secret,
    firePath: `/api/triggers/${trigger.id}/fire/${secret}`,
    warning:
      `${headline} This is the only time the secret is shown. Only its hash is stored; it ` +
      'cannot be recovered, only rotated. The secret is part of the URL, so it can appear in ' +
      'access logs of a proxy or CDN between the sender and this platform: rotate it if one may ' +
      'have leaked.',
  };
}

export async function list(request: Request): Promise<ApiResult> {
  return authorise(request, 'not-applicable', async ({ principal }) => {
    const runtime = servingTriggers();
    if (runtime === null) return notConfigured();
    const records = await (await runtime.repository(principal.workspaceId)).list();
    const withZoom =
      runtime.zoomTokens === null
        ? new Set<string>()
        : await runtime.zoomTokens.configured(
            principal.workspaceId,
            records.map((record) => record.id),
          );
    return {
      status: 200,
      body: { triggers: records.map((record) => resource(record, withZoom.has(record.id))) },
    };
  });
}

type CreateOutcome = Awaited<
  ReturnType<Awaited<ReturnType<TriggersRuntime['repository']>>['create']>
>;

/** The answer for every create outcome that stored nothing. */
function createRefusal(
  outcome: Exclude<CreateOutcome, { kind: 'created' }>,
  input: { readonly name: string; readonly agentId: string },
): ApiResult {
  switch (outcome.kind) {
    case 'name-taken':
      return domainProblem(
        'trigger_name_taken',
        `this workspace already has a trigger named ${JSON.stringify(input.name)}.`,
      );
    case 'agent-not-found':
      return agentNotRunnable(input.agentId);
    case 'owner-not-found':
      return domainProblem(
        'trigger_owner_not_allowed',
        'the member creating this trigger is no longer in the workspace.',
      );
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled trigger create outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

/** A schedule has no request body, so a `{{body}}` in its prompt would always render empty. */
const scheduleBodyRefusal = (prompt: string | undefined): ApiResult | null =>
  prompt?.includes(TRIGGER_BODY_PLACEHOLDER) === true
    ? problem(
        400,
        'invalid_field',
        'a schedule prompt cannot use {{body}}; a schedule has no request body.',
      )
    : null;

export async function create(request: Request): Promise<ApiResult> {
  return authorise(request, 'not-applicable', async ({ principal }) => {
    const runtime = servingTriggers();
    if (runtime === null) return notConfigured();
    if (principal.via === 'api-key') return apiKeyRefusal();
    const raw = await readJsonBody(request);
    if (!raw.ok) return raw.result;
    const parsed = CreateTriggerRequestSchema.safeParse(raw.value);
    if (!parsed.success) return invalidField(parsed.error);
    const input = parsed.data;
    if (input.kind === 'schedule') {
      const invalid = findScheduleError(input.cron, input.timezone);
      if (invalid !== null) return problem(400, 'invalid_field', invalid);
      const refusal = scheduleBodyRefusal(input.prompt);
      if (refusal !== null) return refusal;
    } else if (input.zoomSecretToken !== undefined && runtime.zoomTokens === null) {
      return zoomUnavailable();
    }
    if (input.subject !== undefined && !mayAssertSubject(principal)) return subjectNotAllowed();
    if (!(await mayRunAgent(runtime, principal, input.agentId))) {
      return agentNotRunnable(input.agentId);
    }

    const repository = await runtime.repository(principal.workspaceId);
    const base = {
      agentId: input.agentId,
      name: input.name,
      promptTemplate: input.prompt,
      ownerPrincipalId: principal.ownerPrincipalId,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
      ...(input.subject === undefined ? {} : { subject: input.subject }),
    };
    if (input.kind === 'schedule') {
      const outcome = await repository.create({
        ...base,
        kind: 'schedule',
        cron: input.cron,
        timezone: input.timezone,
      });
      return outcome.kind === 'created'
        ? { status: 201, body: { trigger: resource(outcome.trigger, false) } }
        : createRefusal(outcome, input);
    }

    const minted = await mintClientSecret();
    const outcome = await repository.create({
      ...base,
      kind: 'webhook',
      secretHash: minted.secretHash,
    });
    if (outcome.kind !== 'created') return createRefusal(outcome, input);
    const { trigger } = outcome;
    if (input.zoomSecretToken !== undefined && runtime.zoomTokens !== null) {
      await runtime.zoomTokens.set(trigger.workspaceId, trigger.id, input.zoomSecretToken);
    }
    return {
      status: 201,
      body: secretBody(
        resource(trigger, input.zoomSecretToken !== undefined),
        minted.presented,
        'The trigger was created.',
      ),
    };
  });
}

export async function get(request: Request, id: unknown): Promise<ApiResult> {
  const triggerId = String(id);
  return authorise(request, ownershipOfTrigger(triggerId), async ({ principal }) => {
    const runtime = servingTriggers();
    if (runtime === null) return notConfigured();
    const trigger = await (await runtime.repository(principal.workspaceId)).get(triggerId);
    if (trigger === null) return triggerNotFound(triggerId);
    return {
      status: 200,
      body: { trigger: resource(trigger, await hasZoomToken(runtime.zoomTokens, trigger)) },
    };
  });
}

export async function update(request: Request, id: unknown): Promise<ApiResult> {
  const triggerId = String(id);
  return authorise(request, ownershipOfTrigger(triggerId), async ({ principal }) => {
    const runtime = servingTriggers();
    if (runtime === null) return notConfigured();
    const raw = await readJsonBody(request);
    if (!raw.ok) return raw.result;
    const parsed = UpdateTriggerRequestSchema.safeParse(raw.value);
    if (!parsed.success) return invalidField(parsed.error);
    const patch = parsed.data;

    const repository = await runtime.repository(principal.workspaceId);
    const before = await repository.get(triggerId);
    if (before === null) return triggerNotFound(triggerId);
    // Clearing the subject stays open to any editor; setting one, or touching a trigger that keeps
    // one, takes the API-key decision, so an editor cannot rewrite what runs as someone else.
    const keepsOrSetsSubject =
      patch.subject !== null && (patch.subject !== undefined || before.subject !== null);
    if (keepsOrSetsSubject && !mayAssertSubject(principal)) return subjectNotAllowed();
    if (before.kind === 'schedule') {
      const refusal = scheduleBodyRefusal(patch.prompt);
      if (refusal !== null) return refusal;
    }
    if (patch.zoomSecretToken !== undefined) {
      if (before.kind !== 'webhook') {
        return domainProblem(
          'trigger_not_webhook',
          'only a webhook trigger has a Zoom secret token.',
        );
      }
      if (runtime.zoomTokens === null) return zoomUnavailable();
    }

    const outcome = await repository.update(triggerId, {
      name: patch.name,
      promptTemplate: patch.prompt,
      enabled: patch.enabled,
      outputSchema: patch.outputSchema,
      subject: patch.subject,
    });
    switch (outcome.kind) {
      case 'updated': {
        const { zoomTokens } = runtime;
        if (patch.zoomSecretToken !== undefined && zoomTokens !== null) {
          if (patch.zoomSecretToken === null) await zoomTokens.clear(before.workspaceId, before.id);
          else await zoomTokens.set(before.workspaceId, before.id, patch.zoomSecretToken);
        }
        return {
          status: 200,
          body: {
            trigger: resource(outcome.trigger, await hasZoomToken(zoomTokens, outcome.trigger)),
          },
        };
      }
      case 'not-found':
        return triggerNotFound(triggerId);
      case 'name-taken':
        return domainProblem(
          'trigger_name_taken',
          `this workspace already has a trigger named ${JSON.stringify(patch.name)}.`,
        );
      case 'invalid-shape':
        return domainProblem(
          'trigger_not_webhook',
          'that change does not fit this kind of trigger.',
        );
      default: {
        const unreachable: never = outcome;
        throw new Error(`unhandled trigger update outcome ${JSON.stringify(unreachable)}`);
      }
    }
  });
}

export async function remove(request: Request, id: unknown): Promise<ApiResult> {
  const triggerId = String(id);
  return authorise(request, ownershipOfTrigger(triggerId), async ({ principal }) => {
    const runtime = servingTriggers();
    if (runtime === null) return notConfigured();
    const repository = await runtime.repository(principal.workspaceId);
    const trigger = await repository.get(triggerId);
    if (trigger === null || !(await repository.remove(triggerId))) {
      return triggerNotFound(triggerId);
    }
    await runtime.zoomTokens?.clear(trigger.workspaceId, trigger.id);
    return { status: 200, body: { trigger: resource(trigger, false) } };
  });
}

/** The old secret stops working at once; the new one is in this `201` only. */
export async function rotateSecret(request: Request, id: unknown): Promise<ApiResult> {
  const triggerId = String(id);
  return authorise(request, ownershipOfTrigger(triggerId), async ({ principal }) => {
    const runtime = servingTriggers();
    if (runtime === null) return notConfigured();
    if (principal.via === 'api-key') return apiKeyRefusal();
    const minted = await mintClientSecret();
    const outcome = await (
      await runtime.repository(principal.workspaceId)
    ).setSecretHash(triggerId, minted.secretHash);
    switch (outcome.kind) {
      case 'set':
        return {
          status: 201,
          body: secretBody(
            resource(outcome.trigger, await hasZoomToken(runtime.zoomTokens, outcome.trigger)),
            minted.presented,
            'The previous secret no longer works.',
          ),
        };
      case 'not-found':
        return triggerNotFound(triggerId);
      case 'not-webhook':
        return domainProblem('trigger_not_webhook', 'only a webhook trigger has a URL secret.');
      default: {
        const unreachable: never = outcome;
        throw new Error(`unhandled trigger rotate outcome ${JSON.stringify(unreachable)}`);
      }
    }
  });
}
