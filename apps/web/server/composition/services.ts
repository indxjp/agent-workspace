import { log } from '../telemetry/logger';

import { loadEgressPolicyFromEnv, loadOutboundProxyFromEnv } from '@agent-workspace/core';
import type { DatabaseRoot } from '@agent-workspace/core/db';
import { readDeploymentPosture } from '@agent-workspace/core/posture';
import type { SecretsService } from '@agent-workspace/core/secrets';
import { STORAGE_CONNECTION_FILE_ROOTS_ENV } from '@indx-workspace/contracts/storage-connections';

import { resolveAgentRunOwnership } from '../agents/run-ownership';
import type { AgentsRuntime, WorkspaceResolution } from '../agents/wiring';
import type { Connectors } from '../connectors/wiring';
import type { EndpointClientsRuntime } from '../endpoint-clients/wiring';
import { createRepositoryEndpointClientsRuntime } from '../endpoint-clients/store';
import type { Models } from '../models/wiring';
import { readVertexDefaults } from '../models/vertex-defaults';
import type { OAuthRuntime } from '../oauth/wiring';
import { createRepositoryOAuthRuntime } from '../oauth/store';
import type { Principal } from '../rbac/principal';
import type { Runtimes } from '../runtimes/wiring';
import type { Secrets } from '../secrets/wiring';
import { createRepositorySecretsStoreProvider } from '../secrets/store';
import type { StorageConnections } from '../storage-connections/wiring';
import { createRepositoryStorageConnectionsStoreProvider } from '../storage-connections/store';
import { scriptedModelsOption } from './config';
import type { InstalledModelsApi } from './types';
export {
  installDriverRegistry,
  runnerManagerDriverLabel,
  unavailableRuntimeRegistryEntries,
} from './driver-registry';
export type { SharedRuntimeVerifications } from './runtime-verification';

export async function installModelsApi(
  resolveWorkspace: (request: Request) => Promise<WorkspaceResolution>,
  identifyActor: (request: Request) => Promise<Principal | null>,
  root: DatabaseRoot,
  secretsService: SecretsService | null,
): Promise<{ readonly models: Models; readonly modelsApi: InstalledModelsApi | null }> {
  if (secretsService === null) {
    log.error(
      '[compose] models API NOT installed: provider credentials require the encrypted secrets service. ' +
        'Every /api/models and /api/model-connections route answers 503 models_runtime_not_configured.',
    );
    return { models: { kind: 'unavailable' }, modelsApi: null };
  }

  const [
    { createRepositoryModelsStoreProvider },
    { probeModelConnection },
    { createModelDiscovery },
  ] = await Promise.all([
    import('../models/store'),
    import('../models/probe'),
    import('../models/discovery'),
  ]);
  const models = createRepositoryModelsStoreProvider({
    repositories: root.modelConnections,
    scopes: root.scopes,
    secrets: secretsService,
  });
  // One discovery cache for the whole process (issue #129's short in-memory TTL cache), shared by
  // `GET /api/models` and by every run's model resolution — a run started moments after a
  // `GET /api/models` call should not repeat an identical, still-fresh discovery round trip.
  const discover = createModelDiscovery(scriptedModelsOption(process.env));
  const runtime: Models = {
    kind: 'serving',
    runtime: {
      async resolveActor(request) {
        const resolution = await resolveWorkspace(request);
        if (resolution.kind !== 'workspace') return resolution;
        const actor = await identifyActor(request);
        if (actor === null)
          return { kind: 'forbidden', reason: 'The session no longer has a workspace membership.' };
        return {
          kind: 'workspace',
          workspaceId: actor.workspaceId,
          principalId: actor.principalId,
          userId: actor.userId,
          userLabel: actor.label,
          // issue #149: the membership's role, carried through rather than discarded — every write
          // on a model connection now reaches `decide()` with it (`server/models/http.ts`).
          role: actor.role,
          scope: actor.scope,
        };
      },
      models,
      probe: probeModelConnection,
      discover,
      audit: (event) => root.recordAuditEvent(event),
      log: (message) => log.info(`[models] ${message}`),
      vertexDefaults: readVertexDefaults(process.env),
    },
  };
  log.info(
    '[compose] models API installed: PostgreSQL connection metadata → encrypted provider credential',
  );
  return { models: runtime, modelsApi: { models, discover } };
}

/** Build `/api/connectors*` (spec §8) over PostgreSQL rows and encrypted secret references. */
export async function installConnectorsApi(
  resolveWorkspace: (request: Request) => Promise<WorkspaceResolution>,
  identifyAuditActor: (request: Request) => Promise<Principal | null>,
  root: DatabaseRoot,
  secretsService: SecretsService | null,
): Promise<Connectors> {
  if (secretsService === null) {
    log.error(
      '[compose] connectors API NOT installed: connector credentials require the encrypted ' +
        'secrets service. Every /api/connectors* route answers 503 ' +
        'connectors_runtime_not_configured.',
    );
    return { kind: 'unavailable' };
  }

  const { createRepositoryConnectorsStoreProvider } = await import('../connectors/store');
  const runtime: Connectors = {
    kind: 'serving',
    runtime: {
      resolveWorkspace,
      async recordAudit(request, event) {
        const actor = await identifyAuditActor(request);
        if (actor === null) throw new Error('connector mutation completed without an audit actor');
        const scope = await root.scopes.forWorkspaceId(actor.workspaceId);
        if (scope === null) throw new Error('connector audit workspace no longer exists');
        await root.auditEventRepository.forScope(scope).write({
          actorPrincipalId: actor.principalId,
          actorUserId: actor.userId,
          actorLabel: actor.label,
          action: 'connector-changed',
          subjectId: event.subjectId,
          subjectLabel: event.subjectLabel,
        });
      },
      connectors: createRepositoryConnectorsStoreProvider({
        mcpServers: root.mcpServers,
        secrets: secretsService,
        scopes: root.scopes,
      }),
      // issue #117: `POST /api/connectors` stamps `created_by` from the same identity `recordAudit`
      // above already requires — reused, not re-derived.
      async identifyActor(request) {
        const actor = await identifyAuditActor(request);
        // The connector's owner: a local runtime key's writes are owned by the member it acts for.
        return actor === null
          ? null
          : { principalId: actor.ownerPrincipalId, userId: actor.userId };
      },
    },
  };
  log.info(
    '[compose] connectors API installed: PostgreSQL metadata → encrypted credential reference',
  );
  return runtime;
}

/** Build `/api/endpoint-clients*` (ADR-0134) over the PostgreSQL repository and key directory. */
export function installEndpointClientsApi(root: DatabaseRoot): EndpointClientsRuntime {
  const endpointClients = createRepositoryEndpointClientsRuntime(
    root,
    resolveAgentRunOwnership,
    () => new Date(),
    readDeploymentPosture(process.env),
  );
  log.info('[compose] endpoint clients API installed: PostgreSQL endpoint-scoped API keys');
  return endpointClients;
}

/** Storage connections (the storage design §05): credentials need the encrypted secrets service. */
export function installStorageConnectionsApi(
  root: DatabaseRoot,
  secretsService: SecretsService | null,
): StorageConnections {
  if (secretsService === null) {
    log.error(
      '[compose] storage connections API NOT installed: credentials require the encrypted secrets service. ' +
        'Every /api/storage-connections route answers 503 storage_connections_not_configured.',
    );
    return { kind: 'unavailable' };
  }
  const fileRoots = (process.env[STORAGE_CONNECTION_FILE_ROOTS_ENV] ?? '')
    .split(',')
    .map((root) => root.trim())
    .filter((root) => root !== '');
  return {
    kind: 'serving',
    runtime: {
      store: createRepositoryStorageConnectionsStoreProvider({
        repositories: root.storageConnections,
        scopes: root.scopes,
        secrets: secretsService,
      }),
      fileRoots,
      egress: loadEgressPolicyFromEnv(),
      proxy: loadOutboundProxyFromEnv(process.env),
      isConnectionGranted: async (workspaceId, connectionId) => {
        const scope = await root.scopes.forWorkspaceId(workspaceId);
        return (
          scope !== null && root.agentVersions.forScope(scope).isConnectionGranted(connectionId)
        );
      },
      audit: (event) => root.recordAuditEvent(event),
    },
  };
}

/** Build the OAuth 2.1 server for endpoint clients (ADR-0134 part 3); the root installs it. */
export function installOAuthApi(root: DatabaseRoot): OAuthRuntime {
  const oauth = createRepositoryOAuthRuntime(root);
  log.info('[compose] OAuth server installed: PostgreSQL codes, access and refresh tokens');
  return oauth;
}

/**
 * Build `/api/secrets/**` (spec §23, W2-CP-02).
 *
 * `createSecretsService` is that subsystem's own composition root: it loads the selected
 * master-key provider **before** it opens anything, so a deployment with no key or a malformed one
 * throws here and the routes keep answering `503 secrets_runtime_not_configured`. That
 * ordering is the subsystem's own guarantee (`packages/core/src/secrets/service.ts`), and this
 * function's only contribution to it is to not defeat it: the error is logged and the domain is
 * `unavailable`, never caught and replaced with an in-memory service. `createInMemorySecretsService`
 * exists and is deliberately not called from here — it encrypts under a key invented inside the
 * process, so a deployment running on it would accept secrets it could not read again after a
 * restart, which is the fallback-indistinguishable-from-success shape of ADR-0015.
 *
 * The pool this opens is a second connection to the same PostgreSQL server as `openDatabaseRoot`'s,
 * by design and not by accident — `docs/adr/W2-CP-02-envelope-encryption-and-its-own-connection.md`
 * decision 1 records why, including why a `WorkspaceScope` minted by one is accepted by the other.
 */
export async function installSecretsApi(
  resolveWorkspace: (request: Request) => Promise<WorkspaceResolution>,
  scopes: DatabaseRoot['scopes'],
  storageConnections: DatabaseRoot['storageConnections'],
): Promise<{ readonly secrets: Secrets; readonly secretsService: SecretsService | null }> {
  let secrets: typeof import('@agent-workspace/core/secrets') | undefined;
  try {
    secrets = await import('@agent-workspace/core/secrets');
    const service = await secrets.createSecretsService(process.env);
    log.info(
      '[compose] secrets API installed: envelope encryption under the configured master-key ' +
        'provider, write-only through the routes',
    );
    return {
      secrets: {
        kind: 'serving',
        runtime: {
          resolveWorkspace,
          secrets: createRepositorySecretsStoreProvider({
            service,
            scopes,
            storageConnections,
          }),
        },
      },
      secretsService: service,
    };
  } catch (error) {
    if (secrets !== undefined && error instanceof secrets.MalformedMasterKeyError) {
      // Issue #1562 (owner decision D9): set but malformed is a misconfiguration, not "secrets not
      // configured". The error's message names the variable and the format, never the value.
      log.error(
        '[compose] secrets API NOT installed: MASTER_ENCRYPTION_KEY is set but malformed. ' +
          `${secrets.MASTER_KEY_EXPECTED_FORMAT}. Every /api/secrets/** route answers 503 ` +
          'secrets_runtime_not_configured, and GET /api/readyz answers 503, until it is fixed.',
        { error },
      );
      return {
        secrets: { kind: 'unavailable', reason: 'malformed-master-key' },
        secretsService: null,
      };
    }
    log.error(
      '[compose] secrets API NOT installed. Every /api/secrets/** route answers 503 secrets_runtime_not_configured.',
      { error },
    );
    return { secrets: { kind: 'unavailable' }, secretsService: null };
  }
}

/** Build the profile and connection APIs and the §36 runtime-switch audit sink. */
export async function installRuntimesApi(
  resolveWorkspace: (request: Request) => Promise<WorkspaceResolution>,
  identifyActor: (request: Request) => Promise<Principal | null>,
  root: DatabaseRoot,
  secretsService: SecretsService | null,
): Promise<{
  readonly runtimes: Runtimes;
  readonly runtimeSwitchAudit: NonNullable<AgentsRuntime['runtimeSwitchAudit']> | null;
}> {
  if (secretsService === null) {
    log.error(
      '[compose] runtime APIs NOT installed: runtime connections are encrypted secrets, and the ' +
        'secrets service is unavailable. Runtime switches remain disabled because §36 cannot ' +
        'name both drivers without loading the referenced profiles.',
    );
    return { runtimes: { kind: 'unavailable' }, runtimeSwitchAudit: null };
  }

  const [profileModule, connectionModule, auditModule] = await Promise.all([
    import('../runtimes/store'),
    import('../runtimes/connections'),
    import('../agents/runtime-switch-audit'),
  ]);
  const profiles = profileModule.createRepositoryRuntimeProfileStoreProvider({
    repositories: root.runtimeProfiles,
    scopes: root.scopes,
  });
  const runtime = {
    resolveWorkspace,
    profiles,
    connections: connectionModule.createSecretsRuntimeConnectionStoreProvider({
      secrets: secretsService,
      scopes: root.scopes,
    }),
  };
  log.info(
    '[compose] runtime profile and connection APIs installed: PostgreSQL profiles + encrypted connections',
  );

  const runtimeSwitchAudit = auditModule.createRuntimeSwitchAudit({
    profiles,
    identifyActor: async (request) => {
      const actor = await identifyActor(request);
      return actor === null
        ? null
        : {
            workspaceId: actor.workspaceId,
            principalId: actor.principalId,
            userId: actor.userId,
            userLabel: actor.label,
          };
    },
    recordAuditEvent: (event) => root.recordAuditEvent(event),
  });
  return { runtimes: { kind: 'serving', runtime }, runtimeSwitchAudit };
}
