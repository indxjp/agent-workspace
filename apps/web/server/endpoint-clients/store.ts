/**
 * The PostgreSQL-backed {@link EndpointClientsRuntime} (issue #949, ADR-0134): the repository's
 * records projected to the contract's resources, the endpoint-scoped key minted through the
 * directory, and the audit rows written for the caller.
 */
import type {
  DatabaseRoot,
  DirectoryApiKeyRecord,
  EndpointClientRecord,
} from '@agent-workspace/core/db';
import type { ApiKeyResource } from '@indx-workspace/contracts/api-keys';
import type { EndpointClientResource } from '@indx-workspace/contracts/endpoint-clients';

import { resolveAgentRunOwnership } from '../agents/run-ownership';
import { mintApiKey } from '../rbac/api-key';
import type { EndpointClientsRuntime } from './runtime';

type StoreRoot = Pick<
  DatabaseRoot,
  'scopes' | 'endpointClients' | 'directory' | 'auditEventRepository'
>;

function resource(record: EndpointClientRecord): EndpointClientResource {
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    agentIds: record.agentIds,
    toolNames: record.toolNames,
    actsForPrincipalId: record.actsForPrincipalId,
    apiKeyIds: record.apiKeyIds,
    redirectUris: record.redirectUris,
    hasClientSecret: record.hasClientSecret,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function apiKeyResource(row: DirectoryApiKeyRecord): ApiKeyResource {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    keyPrefix: row.keyPrefix,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createRepositoryEndpointClientsRuntime(
  root: StoreRoot,
  now: () => Date = () => new Date(),
): EndpointClientsRuntime {
  const repository = async (workspaceId: string) => {
    const scope = await root.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('endpoint-client workspace no longer exists');
    return root.endpointClients.forScope(scope);
  };

  return {
    async list(workspaceId) {
      return (await (await repository(workspaceId)).list()).map(resource);
    },
    async get(workspaceId, id) {
      const record = await (await repository(workspaceId)).get(id);
      return record === null ? null : resource(record);
    },
    async create(workspaceId, input) {
      const outcome = await (await repository(workspaceId)).create(input);
      return outcome.kind === 'name-taken'
        ? outcome
        : { kind: 'created', client: resource(outcome.client) };
    },
    async update(workspaceId, id, patch) {
      const outcome = await (await repository(workspaceId)).update(id, patch);
      return outcome.kind === 'updated'
        ? { kind: 'updated', client: resource(outcome.client) }
        : outcome;
    },
    async revoke(workspaceId, id) {
      const revocation = await (await repository(workspaceId)).revoke(id, now());
      return revocation === null
        ? null
        : { client: resource(revocation.client), revokedKeys: revocation.revokedKeys };
    },
    async rotateSecret(workspaceId, id, secretHash) {
      const outcome = await (await repository(workspaceId)).setSecretHash(id, secretHash, now());
      return outcome.kind === 'set'
        ? { kind: 'rotated', client: resource(outcome.client) }
        : outcome;
    },
    async mintKey(workspaceId, id, input) {
      const client = await (await repository(workspaceId)).get(id);
      if (client === null) return { kind: 'not-found' };
      const createdAt = now();
      let expiresAt: Date | null = null;
      if (input.expiresAt !== null) {
        expiresAt = new Date(input.expiresAt);
        if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= createdAt.getTime()) {
          return { kind: 'expiry-in-the-past', expiresAt: input.expiresAt };
        }
      }
      const minted = await mintApiKey();
      const outcome = await root.directory.forWorkspace(workspaceId).createEndpointApiKey({
        name: input.name.trim(),
        role: 'builder',
        keyPrefix: minted.keyPrefix,
        keyHash: minted.keyHash,
        expiresAt,
        endpointClientId: id,
        actsForPrincipalId: client.actsForPrincipalId,
      });
      switch (outcome.kind) {
        case 'created':
          return {
            kind: 'created',
            apiKey: apiKeyResource(outcome.key),
            presented: minted.presented,
          };
        case 'name-taken':
          return outcome;
        case 'no-such-endpoint-client':
          return { kind: 'not-found' };
        case 'endpoint-client-revoked':
          return { kind: 'revoked' };
        default: {
          const unreachable: never = outcome;
          throw new Error(`unhandled createEndpointApiKey outcome ${JSON.stringify(unreachable)}`);
        }
      }
    },
    agentOwnership: (principal, agentId) => resolveAgentRunOwnership(principal, agentId),
    async audit(principal, event) {
      const scope = await root.scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) throw new Error('endpoint-client audit workspace no longer exists');
      await root.auditEventRepository.forScope(scope).write({
        actorPrincipalId: principal.principalId,
        actorUserId: principal.userId,
        actorLabel: principal.label,
        action: event.action,
        subjectId: event.subjectId,
        subjectLabel: event.subjectLabel,
      });
    },
  };
}
