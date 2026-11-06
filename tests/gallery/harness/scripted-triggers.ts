import type { RunResource } from '@indx-workspace/contracts/runs';
import {
  CreateTriggerRequestSchema,
  renderTriggerPrompt,
  TriggerResourceSchema,
  type TriggerResource,
} from '@indx-workspace/contracts/triggers';
import { jsonResponse, type RecordedRequest } from '@indx-workspace/sdk/testing';
import { randomUUID } from 'node:crypto';
import type { ScriptedStart } from './scripted-run-lifecycle.ts';

export function createScriptedTriggers(begin: (body: ScriptedStart) => Promise<RunResource>) {
  const triggers: TriggerResource[] = [];
  const secrets = new Map<string, string>();
  // One run per (trigger, Idempotency-Key); the promise is kept so two concurrent fires share it.
  const deliveries = new Map<string, Promise<RunResource>>();

  const notFound = (): Response =>
    jsonResponse(404, { error: { code: 'trigger_not_found', message: 'No such trigger.' } });

  function createTrigger(request: RecordedRequest): Response {
    const parsed = CreateTriggerRequestSchema.safeParse(request.json);
    if (!parsed.success) {
      return jsonResponse(400, {
        error: {
          code: 'invalid_body',
          message: parsed.error.issues.map((issue) => issue.message).join('; '),
        },
      });
    }
    const input = parsed.data;
    const now = new Date().toISOString();
    const trigger = TriggerResourceSchema.parse({
      id: randomUUID(),
      name: input.name,
      kind: input.kind,
      agentId: input.agentId,
      prompt: input.prompt,
      cron: input.kind === 'schedule' ? input.cron : null,
      timezone: input.kind === 'schedule' ? input.timezone : null,
      enabled: input.enabled ?? true,
      outputSchema: input.outputSchema ?? null,
      subject: input.subject ?? null,
      ownerPrincipalId: randomUUID(),
      hasSecret: input.kind === 'webhook',
      hasZoomSecretToken: input.kind === 'webhook' && input.zoomSecretToken !== undefined,
      lastFiredAt: null,
      createdAt: now,
      updatedAt: now,
    });
    triggers.push(trigger);
    if (input.kind === 'schedule') return jsonResponse(201, { trigger });
    const secret = `awts_test_${randomUUID().replaceAll('-', '')}`;
    secrets.set(trigger.id, secret);
    return jsonResponse(201, {
      trigger,
      secret,
      firePath: `/api/triggers/${trigger.id}/fire/${secret}`,
      warning: 'Store this URL now; the secret is not shown again.',
    });
  }

  function startTriggered(trigger: TriggerResource, body: string, key: string | null) {
    const delivery = async (): Promise<RunResource> =>
      begin({
        prompt: renderTriggerPrompt(trigger.prompt, body),
        sessionId: null,
        outputSchema: trigger.outputSchema,
        subject: trigger.subject,
      });
    if (key === null) return delivery();
    const id = `${trigger.id}:${key}`;
    const known = deliveries.get(id);
    if (known !== undefined) return known;
    const started = delivery();
    deliveries.set(id, started);
    started.catch(() => deliveries.delete(id));
    return started;
  }

  async function fireWebhook(request: RecordedRequest, id: string, secret: string) {
    const trigger = triggers.find((candidate) => candidate.id === id);
    if (trigger?.kind !== 'webhook' || !trigger.enabled || secrets.get(id) !== secret) {
      return notFound();
    }
    const body = typeof request.init.body === 'string' ? request.init.body : '';
    const run = await startTriggered(trigger, body, request.headers.get('idempotency-key'));
    return jsonResponse(202, { run });
  }

  return { triggers, createTrigger, fireWebhook, startTriggered };
}
