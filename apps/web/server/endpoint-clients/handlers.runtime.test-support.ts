import type { EndpointClientResource } from '@indx-workspace/contracts/endpoint-clients';
import { randomUUID } from 'node:crypto';
import { installTestDomains } from '../application-context-fixtures';
import type { EndpointClientAuditEvent, EndpointClientsRuntime } from './runtime';

export interface EndpointClientState {
  readonly clients: Map<string, EndpointClientResource & { workspaceId: string }>;
  readonly agentOwners: Map<string, string>;
  /** `agentId:ownerPrincipalId` pairs an `agent_grants` row names. */
  readonly agentGrants: Set<string>;
  readonly audits: EndpointClientAuditEvent[];
  /** Key id to key name, for every key minted. */
  readonly keyNames: Map<string, string>;
  /** Client id to the stored secret hash. */
  readonly secretHashes: Map<string, string>;
}

/** The runtime with each method's `Promise` removed, so the fake needs no `async`. */
type SyncRuntime = {
  [K in keyof EndpointClientsRuntime]: EndpointClientsRuntime[K] extends (
    ...args: infer A
  ) => Promise<infer R>
    ? (...args: A) => R
    : never;
};

const clientResource = (
  c: EndpointClientResource & { workspaceId: string },
): EndpointClientResource => ({
  id: c.id,
  name: c.name,
  kind: c.kind,
  agentIds: c.agentIds,
  toolNames: c.toolNames,
  actsForPrincipalId: c.actsForPrincipalId,
  apiKeyIds: c.apiKeyIds,
  redirectUris: c.redirectUris,
  oidcAudience: c.oidcAudience,
  hasClientSecret: c.hasClientSecret,
  revokedAt: c.revokedAt,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});
const inWorkspace = (state: EndpointClientState, workspaceId: string, id: string) => {
  const client = state.clients.get(id);
  return client !== undefined && client.workspaceId === workspaceId ? client : null;
};
function clientOperations(
  state: EndpointClientState,
): Pick<SyncRuntime, 'list' | 'get' | 'create' | 'update'> {
  return {
    list: (workspaceId) =>
      [...state.clients.values()].filter((c) => c.workspaceId === workspaceId).map(clientResource),
    get: (workspaceId, id) => {
      const client = inWorkspace(state, workspaceId, id);
      return client === null ? null : clientResource(client);
    },
    create: (workspaceId, input) => {
      for (const c of state.clients.values()) {
        if (c.workspaceId === workspaceId && c.kind === input.kind && c.name === input.name) {
          return { kind: 'name-taken' };
        }
      }
      const now = new Date().toISOString();
      const client = {
        id: randomUUID(),
        workspaceId,
        name: input.name,
        kind: input.kind,
        agentIds: input.agentIds,
        toolNames: input.toolNames,
        oidcAudience: input.oidcAudience,
        actsForPrincipalId: input.actsForPrincipalId,
        apiKeyIds: [],
        redirectUris: [],
        hasClientSecret: false,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      state.clients.set(client.id, client);
      return { kind: 'created', client: clientResource(client) };
    },
    update: (workspaceId, id, patch) => {
      const client = inWorkspace(state, workspaceId, id);
      if (client === null) return { kind: 'not-found' };
      if (client.revokedAt !== null) return { kind: 'revoked' };
      const next = {
        ...client,
        agentIds: patch.agentIds ?? client.agentIds,
        toolNames: patch.toolNames === undefined ? client.toolNames : patch.toolNames,
        redirectUris: patch.redirectUris ?? client.redirectUris,
        oidcAudience: patch.oidcAudience ?? client.oidcAudience,
      };
      state.clients.set(id, next);
      return { kind: 'updated', client: clientResource(next) };
    },
  };
}

function credentialOperations(
  state: EndpointClientState,
): Pick<SyncRuntime, 'revoke' | 'rotateSecret' | 'mintKey'> {
  return {
    revoke: (workspaceId, id) => {
      const client = inWorkspace(state, workspaceId, id);
      if (client === null) return null;
      const revokedKeys =
        client.revokedAt === null
          ? client.apiKeyIds.map((keyId) => ({ id: keyId, name: state.keyNames.get(keyId) ?? '' }))
          : [];
      const next = { ...client, revokedAt: client.revokedAt ?? new Date().toISOString() };
      state.clients.set(id, next);
      return { client: clientResource(next), revokedKeys };
    },
    rotateSecret: (workspaceId, id, secretHash) => {
      const client = inWorkspace(state, workspaceId, id);
      if (client === null) return { kind: 'not-found' };
      if (client.revokedAt !== null) return { kind: 'revoked' };
      state.secretHashes.set(id, secretHash);
      const next = { ...client, hasClientSecret: true };
      state.clients.set(id, next);
      return { kind: 'rotated', client: clientResource(next) };
    },
    mintKey: (workspaceId, id, input) => {
      const client = inWorkspace(state, workspaceId, id);
      if (client === null) return { kind: 'not-found' };
      if (client.revokedAt !== null) return { kind: 'revoked' };
      if ([...state.keyNames.values()].includes(input.name)) {
        return { kind: 'name-taken', name: input.name };
      }
      const keyId = randomUUID();
      state.keyNames.set(keyId, input.name);
      state.clients.set(id, { ...client, apiKeyIds: [...client.apiKeyIds, keyId] });
      return {
        kind: 'created',
        presented: 'aw_live_PLAINTEXT-SECRET-VALUE',
        apiKey: {
          id: keyId,
          name: input.name,
          role: 'builder',
          keyPrefix: 'aw_live_PLAI',
          lastUsedAt: null,
          expiresAt: input.expiresAt,
          revokedAt: null,
          createdAt: new Date().toISOString(),
        },
      };
    },
  };
}

function runtimeOperations(state: EndpointClientState, isLocalPosture: () => boolean): SyncRuntime {
  return {
    ...clientOperations(state),
    ...credentialOperations(state),
    agentOwnership: (principal, agentId) => {
      const owner = state.agentOwners.get(agentId);
      if (owner === undefined) return 'unknown';
      if (owner === principal.ownerPrincipalId) return 'own';
      return state.agentGrants.has(`${agentId}:${principal.ownerPrincipalId}`)
        ? 'permitted'
        : 'other';
    },
    audit: (_principal, event) => {
      state.audits.push(event);
    },
    isLocalPosture: isLocalPosture,
  };
}

export function installEndpointClientRuntime(isLocalPosture: () => boolean): EndpointClientState {
  const state: EndpointClientState = {
    clients: new Map(),
    agentOwners: new Map(),
    agentGrants: new Set(),
    audits: [],
    keyNames: new Map(),
    secretHashes: new Map(),
  };
  const sync = runtimeOperations(state, isLocalPosture);
  installTestDomains({
    endpointClients: {
      list: (...a) => Promise.resolve(sync.list(...a)),
      get: (...a) => Promise.resolve(sync.get(...a)),
      create: (...a) => Promise.resolve(sync.create(...a)),
      update: (...a) => Promise.resolve(sync.update(...a)),
      revoke: (...a) => Promise.resolve(sync.revoke(...a)),
      rotateSecret: (...a) => Promise.resolve(sync.rotateSecret(...a)),
      mintKey: (...a) => Promise.resolve(sync.mintKey(...a)),
      agentOwnership: (...a) => Promise.resolve(sync.agentOwnership(...a)),
      audit: (...a) => Promise.resolve(sync.audit(...a)),
      isLocalPosture: () => Promise.resolve(sync.isLocalPosture()),
    },
  });
  return state;
}
