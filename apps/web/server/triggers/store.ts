/**
 * The PostgreSQL-backed {@link TriggersRuntime} (issue #1293, ADR-0144): the repository of one
 * workspace, the ingress lookup, the owner principal, and the Zoom token kept as a secret.
 */
import type { DatabaseRoot } from '@agent-workspace/core/db';
import type { SecretsService } from '@agent-workspace/core/secrets';

import { resolveAgentRunOwnership } from '../agents/run-ownership';
import { Principal } from '../rbac/principal';
import type { TriggersRuntime, ZoomSecretTokens } from './runtime';

type StoreRoot = Pick<DatabaseRoot, 'scopes' | 'triggers' | 'directory' | 'findTriggerForIngress'>;

/** `TRIGGER_<ID without dashes, upper-case>_ZOOM_TOKEN`, a valid secret name. */
const zoomTokenSecretName = (triggerId: string): string =>
  `TRIGGER_${triggerId.replaceAll('-', '').toUpperCase()}_ZOOM_TOKEN`;

function createZoomTokens(root: StoreRoot, secrets: SecretsService): ZoomSecretTokens {
  const scopeOf = async (workspaceId: string) => {
    const scope = await root.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('trigger workspace no longer exists');
    return scope;
  };
  return {
    async configured(workspaceId, triggerIds) {
      const names = new Set((await secrets.list(await scopeOf(workspaceId))).map((s) => s.name));
      return new Set(triggerIds.filter((id) => names.has(zoomTokenSecretName(id))));
    },
    async set(workspaceId, triggerId, token) {
      const scope = await scopeOf(workspaceId);
      const name = zoomTokenSecretName(triggerId);
      const existing = (await secrets.list(scope)).find((secret) => secret.name === name);
      const value = Buffer.from(token, 'utf8');
      if (existing !== undefined) await secrets.replace(scope, existing.id, value);
      else await secrets.create(scope, { name, value });
    },
    async clear(workspaceId, triggerId) {
      const scope = await scopeOf(workspaceId);
      const name = zoomTokenSecretName(triggerId);
      const existing = (await secrets.list(scope)).find((secret) => secret.name === name);
      if (existing !== undefined) await secrets.delete(scope, existing.id);
    },
    async read(workspaceId, triggerId) {
      const resolved = await secrets.resolveByName(
        await scopeOf(workspaceId),
        zoomTokenSecretName(triggerId),
      );
      return resolved === null ? null : resolved.value.toString('utf8');
    },
  };
}

export function createRepositoryTriggersRuntime(
  root: StoreRoot,
  secrets: SecretsService | null,
  now: () => Date = () => new Date(),
): TriggersRuntime {
  return {
    async repository(workspaceId) {
      const scope = await root.scopes.forWorkspaceId(workspaceId);
      if (scope === null) throw new Error('trigger workspace no longer exists');
      return root.triggers.forScope(scope);
    },
    findForIngress: (triggerId) => root.findTriggerForIngress(triggerId),
    async owner(workspaceId, principalId) {
      const record = await root.directory.principalById(workspaceId, principalId);
      if (record === null) return null;
      return Principal.fromDirectoryRecord({
        principalId,
        kind: record.kind,
        workspaceId,
        role: record.role,
        label: record.label,
        userId: record.userId,
        apiKeyId: record.apiKeyId,
        actsForPrincipalId: record.actsForPrincipalId,
      });
    },
    agentOwnership: (principal, agentId) => resolveAgentRunOwnership(principal, agentId),
    zoomTokens: secrets === null ? null : createZoomTokens(root, secrets),
    now,
  };
}
