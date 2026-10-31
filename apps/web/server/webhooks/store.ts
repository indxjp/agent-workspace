/**
 * The PostgreSQL-backed webhook runtime (N-3, issue #250, ADR-SDK-18-N3-250): the repository of one
 * workspace, the signing secret kept in `SecretsService`, the egress check of a new URL, and the
 * delivery worker's sources (the outbox, the scoped run read, the maintenance lease). The one
 * webhook file that names `@agent-workspace/core/db` (F-15).
 */
import { checkEgress, loadEgressPolicyFromEnv } from '@agent-workspace/core';
import type { DatabaseRoot, WorkspaceScope } from '@agent-workspace/core/db';
import type { SecretsService } from '@agent-workspace/core/secrets';
import { RunResourceSchema } from '@indx-workspace/contracts/runs';

import { renderRun } from '../runs/api';
import { webhookSigningSecretName } from '../secrets/contract';
import type { WebhookDeliverySources, WebhookSigningSecrets, WebhooksRuntime } from './runtime';

type StoreRoot = Pick<
  DatabaseRoot,
  'scopes' | 'webhooks' | 'webhookDeliveries' | 'runs' | 'tryAcquireMaintenanceLease'
>;

async function scopeOf(root: StoreRoot, workspaceId: string): Promise<WorkspaceScope> {
  const scope = await root.scopes.forWorkspaceId(workspaceId);
  if (scope === null) throw new Error('webhook workspace no longer exists');
  return scope;
}

function createSigningSecrets(root: StoreRoot, secrets: SecretsService): WebhookSigningSecrets {
  return {
    async store(workspaceId, webhookId, secret) {
      const scope = await scopeOf(root, workspaceId);
      const name = webhookSigningSecretName(webhookId);
      const value = Buffer.from(secret, 'utf8');
      const existing = (await secrets.list(scope)).find((stored) => stored.name === name);
      if (existing !== undefined) {
        await secrets.replace(scope, existing.id, value);
        return;
      }
      const outcome = await secrets.create(scope, { name, value });
      if (outcome.kind !== 'created') throw new Error('the webhook signing secret was not stored');
    },
    async remove(workspaceId, webhookId) {
      const scope = await scopeOf(root, workspaceId);
      const name = webhookSigningSecretName(webhookId);
      const existing = (await secrets.list(scope)).find((stored) => stored.name === name);
      if (existing !== undefined) await secrets.delete(scope, existing.id);
    },
    async read(workspaceId, webhookId) {
      const scope = await root.scopes.forWorkspaceId(workspaceId);
      if (scope === null) return null;
      const resolved = await secrets.resolveByName(scope, webhookSigningSecretName(webhookId));
      return resolved === null ? null : resolved.value.toString('utf8');
    },
  };
}

/** The routes' runtime. */
export function createRepositoryWebhooksRuntime(
  root: StoreRoot,
  secrets: SecretsService,
): WebhooksRuntime {
  return {
    async repository(workspaceId) {
      return root.webhooks.forScope(await scopeOf(root, workspaceId));
    },
    secrets: createSigningSecrets(root, secrets),
    async checkUrl(url) {
      const decision = await checkEgress(url, loadEgressPolicyFromEnv());
      return decision.ok
        ? { ok: true }
        : { ok: false, host: decision.host, reason: decision.reason };
    },
  };
}

/** The delivery worker's sources. */
export function createRepositoryWebhookDeliverySources(
  root: StoreRoot,
  secrets: SecretsService,
): WebhookDeliverySources {
  return {
    outbox: root.webhookDeliveries,
    async readRun(workspaceId, runId) {
      const scope = await root.scopes.forWorkspaceId(workspaceId);
      if (scope === null) return null;
      const run = await root.runs.forScope(scope).get(runId);
      return run === null ? null : RunResourceSchema.parse(renderRun(run));
    },
    secrets: createSigningSecrets(root, secrets),
    lease: { tryAcquire: (name, ttlMs) => root.tryAcquireMaintenanceLease(name, ttlMs) },
  };
}
