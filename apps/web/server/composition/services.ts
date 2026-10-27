import { log } from '../telemetry/logger';
import { createHash } from 'node:crypto';

import { loadEgressPolicyFromEnv } from '@agent-workspace/core';
import type { RuntimeDriverId } from '@agent-workspace/run-protocol';
import type { DatabaseRoot } from '@agent-workspace/core/db';
import { DEPLOYMENT_POSTURE_ENV, readDeploymentPosture } from '@agent-workspace/core/posture';
import type { SecretsService } from '@agent-workspace/core/secrets';
import type { RuntimeRunSpec } from '@agent-workspace/runtime/driver';
import { STORAGE_CONNECTION_FILE_ROOTS_ENV } from '@indx-workspace/contracts/storage-connections';

import type { AgentsRuntime, WorkspaceResolution } from '../agents/runtime';
import type { Connectors } from '../connectors/runtime';
import type { EndpointClientsRuntime } from '../endpoint-clients/runtime';
import { createRepositoryEndpointClientsRuntime } from '../endpoint-clients/store';
import { registeredEngines } from '../engines/registry';
import type { Models } from '../models/runtime';
import type { OAuthRuntime } from '../oauth/runtime';
import { createRepositoryOAuthRuntime } from '../oauth/store';
import type { Secrets } from '../secrets/runtime';
import { createRepositorySecretsStoreProvider } from '../secrets/store';
import type { StorageConnections } from '../storage-connections/runtime';
import { createRepositoryStorageConnectionsStoreProvider } from '../storage-connections/store';
import type { RuntimeManagerClient } from '../compose/runtime-manager-client';
import type { ProviderCredentialSpec } from '../compose/runtime-provider-credential';
import type { RuntimeProbeConfig } from '../runtimes/registry';
import type { Runtimes } from '../runtimes/runtime';
import type { Principal } from '../rbac/principal';
import {
  configuredPath,
  enforceableRuntimeNetworkPolicies,
  runnerManagerDriverId,
  runtimeNetworkPolicyRefusal,
} from './config';
import type { InstalledModelsApi } from './types';

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
  const discover = createModelDiscovery();
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
  const endpointClients = createRepositoryEndpointClientsRuntime(root);
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

// ── The sub-wave 2b-1 installers ────────────────────────────────────────────────────────────────
//
// One function per subsystem, below {@link register} rather than inside it, because each is a
// paragraph of configuration reasoning and inlining four of them would bury the ordering that is
// the whole content of a composition root (§53).
//
// Every one of them loads its implementation with a **dynamic** `import` expression carrying a
// string literal, for the reason {@link register}'s header records at length and which was measured
// rather than inferred: Next.js compiles this file for the edge runtime as well as for Node, a
// top-level import is resolved before the `NEXT_RUNTIME` guard can run, and `pg`, `node:fs` and
// `node:path` do not exist on the edge. `@agent-workspace/core/secrets` opens a `pg.Pool`,
// `@agent-workspace/core/storage` reaches `node:fs`, so both are loaded here and not at the top
// of the file. The `Secrets` type is a static import, because its module imports nothing but
// types.

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

export function runnerManagerDriverLabel(driverId: RuntimeDriverId): string {
  const labels: Partial<Record<RuntimeDriverId, string>> = {
    docker: 'Docker',
    'cloud-run-service': 'Google Cloud Run (per-session service)',
    'aca-sessions': 'Azure Container Apps dynamic sessions',
  };
  return labels[driverId] ?? driverId;
}

type UnavailableRuntimeEntry = readonly [RuntimeDriverId, string, false, false];

/**
 * Static registry rows, excluding the driver represented by the live runner-manager row. `local`,
 * `docker`, `cloud-run-service` and `cloudflare-sandbox` have no static row here; the pin in
 * `runtimes/driver-catalogue.test.ts` records that.
 */
export function unavailableRuntimeRegistryEntries(
  managedDriverId: RuntimeDriverId,
): readonly UnavailableRuntimeEntry[] {
  const entries: readonly UnavailableRuntimeEntry[] = [
    ['sandbox-runtime', 'Sandboxed process', false, false],
    ['aca-sessions', 'Azure Container Apps dynamic sessions', false, false],
    ['aws-agentcore', 'Amazon Bedrock AgentCore Runtime', false, false],
    ['aws-ecs', 'Amazon ECS on Fargate', false, false],
    ['cloud-run-sandbox', 'Google Cloud Run sandboxes', false, false],
    ['gke-agent-sandbox', 'GKE Agent Sandbox', false, false],
    ['external', 'External provider', false, false],
    ['vercel-sandbox', 'Vercel Sandbox', false, false],
    ['kubernetes', 'Kubernetes', false, false],
  ];
  return entries.filter(([id]) => id !== managedDriverId);
}

/**
 * Where a workspace's passing Test Runtime is kept so that every instance serving it sees it. The
 * verification file is per process, and a serverless host runs the test and the run on different
 * instances (issue #827).
 */
export interface SharedRuntimeVerifications {
  get(
    workspaceId: string,
    driverId: string,
  ): Promise<Readonly<{ configurationKey: string; expiresAt: Date }> | null>;
  record(
    workspaceId: string,
    driverId: string,
    verification: Readonly<{
      configurationKey: string;
      fingerprint: string;
      verifiedAt: Date;
      expiresAt: Date;
    }>,
  ): Promise<void>;
}

/** Install the live registry used by the Runtimes page and its Test Runtime endpoint. */
export async function installDriverRegistry(
  runnerManager: RuntimeManagerClient | null,
  runnerManagerUrl: string | null,
  verificationNetworkPolicy: RuntimeRunSpec['networkPolicy'],
  resolveProviderCredential?: (
    workspaceId: string,
    spec: ProviderCredentialSpec,
  ) => Promise<string | undefined>,
  sharedVerifications?: SharedRuntimeVerifications,
): Promise<void> {
  // Read before the try block (contract C2): an invalid posture or RUNTIME_DRIVER must fail
  // composition, not be logged as "registry NOT installed" and leave the process running.
  const posture = readDeploymentPosture(process.env);
  // `managedDriverId` is whichever driver the runner manager itself is configured with (see
  // {@link runnerManagerDriverId}) — `'docker'` unless RUNTIME_DRIVER says otherwise, so an
  // existing compose deployment sees the same row it always has.
  const managedDriverId = runnerManagerDriverId(process.env);
  const managedDriverLabel = runnerManagerDriverLabel(managedDriverId);
  try {
    const registryModule = await import('../runtimes/registry');
    const echoConnection = (value: string) => ({
      events: (async function* () {
        await Promise.resolve();
        yield value;
      })(),
      sessionId: Promise.resolve(crypto.randomUUID()),
      interrupt: () => Promise.resolve(),
    });
    // The web process never owns the runner manager's own lifecycle machinery (a Docker socket, a
    // Cloud Run Admin API client, …). That capability belongs to the runner manager; until it
    // positively reports the capability, the UI keeps this driver visible and unavailable. Most
    // importantly, the runner manager being unreachable cannot prevent the independent local
    // driver from registering.
    const image = configuredPath('RUNTIME_IMAGE') ?? 'agent-workspace/runtime:dev';
    const verificationPath =
      configuredPath('AW_RUNTIME_VERIFICATION_FILE') ??
      (posture === 'production'
        ? '/var/lib/agent-workspace/runtime-verifications.json'
        : '.agent-workspace/runtime-verifications.json');
    const { loadRuntimeVerificationCache } = await import('../runtimes/verification-store');
    const verified = await loadRuntimeVerificationCache(verificationPath);
    // S1-22 (issue #504, ADR-0109 as amended): under posture `local` the `local` driver is the
    // in-process runner. `aw dev` starts with `RUNTIME_DRIVER=local`, which makes the managed
    // driver `local` too; under posture `local` that entry must not replace the in-process driver's
    // key or take over its Test Runtime.
    const inProcessLocalDriver = posture === 'local';
    // Only an explicit `AW_DEPLOYMENT_POSTURE=local` (what the local runtime `aw dev` starts sets)
    // has had HOST checked against loopback (`checkDeploymentPosture`). There, and only there, the
    // in-process driver counts as verified without the one-hour verification only the Runtimes
    // screen or the setup wizard records, which `aw dev` never visits: its Test Runtime is an echo
    // that cannot fail. The implicit `local` posture (no variable, `NODE_ENV` not `production`)
    // checked no HOST, so it keeps needing a Test Runtime like every other posture and driver.
    const verifiedWithoutTest =
      inProcessLocalDriver && (process.env[DEPLOYMENT_POSTURE_ENV] ?? '').trim().length > 0;
    // #786: under that same posture a managed `docker` driver is `aw dev --sandbox docker`'s runner
    // manager, which ran its own create/readiness/echo/destroy verification before this process
    // started, and the start fails when it does not pass (`packages/embedded/src/docker-sandbox.ts`).
    const verifiedAtStart = (driverId: string): boolean =>
      verifiedWithoutTest &&
      driverId === 'docker' &&
      managedDriverId === 'docker' &&
      runnerManager !== null;
    const configurationKeys = new Map<string, string>([['local', 'development-local']]);
    if (!(inProcessLocalDriver && managedDriverId === 'local')) {
      configurationKeys.set(
        managedDriverId,
        createHash('sha256')
          .update(JSON.stringify({ image, runnerManagerUrl, verificationNetworkPolicy }))
          .digest('hex'),
      );
    }
    const registry = {
      wasVerified: async (driverId: string, workspaceId?: string) => {
        if (verifiedWithoutTest && driverId === 'local') return true;
        if (verifiedAtStart(driverId)) return true;
        const configurationKey = configurationKeys.get(driverId);
        if (configurationKey === undefined) return false;
        if (verified.wasVerified(driverId, configurationKey)) return true;
        if (sharedVerifications === undefined || workspaceId === undefined) return false;
        const shared = await sharedVerifications.get(workspaceId, driverId);
        return (
          shared !== null &&
          shared.configurationKey === configurationKey &&
          shared.expiresAt.getTime() > Date.now()
        );
      },
      // BH061-002: a lapsed pass (24 hours, or an image upgrade that changed the key) is renewed
      // by the run that finds it, rather than failing every run until someone re-tests by hand.
      hasPassed: async (driverId: string, workspaceId: string) =>
        verified.hasPassed(driverId) ||
        (sharedVerifications !== undefined &&
          (await sharedVerifications.get(workspaceId, driverId)) !== null),
      async test(
        driverId: string,
        _config: RuntimeProbeConfig,
        request: string,
        renderEvent: (event: string) => string,
      ) {
        const transcript: string[] = [];
        if (driverId === managedDriverId && !(inProcessLocalDriver && driverId === 'local')) {
          if (runnerManager === null) throw new Error('the runner manager is not configured');
          // The workspace comes from the caller's session, never from a request body.
          const providerCredential =
            _config.providerCredential ??
            (resolveProviderCredential === undefined || _config.workspaceId === undefined
              ? undefined
              : await resolveProviderCredential(_config.workspaceId, {
                  driver: managedDriverId,
                  ...(_config.runtimeConnectionId === undefined
                    ? {}
                    : { runtimeConnectionId: _config.runtimeConnectionId }),
                }));
          const result = await runnerManager.verify(_config, managedDriverId, providerCredential);
          const expiresAt = Date.parse(result.expiresAt);
          if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            throw new Error('the runner manager returned an expired verification');
          }
          const configurationKey = configurationKeys.get(managedDriverId) ?? '';
          await verified.record(driverId, configurationKey, result);
          if (sharedVerifications !== undefined && _config.workspaceId !== undefined) {
            await sharedVerifications.record(_config.workspaceId, driverId, {
              configurationKey,
              fingerprint: result.fingerprint,
              verifiedAt: new Date(result.verifiedAt),
              expiresAt: new Date(expiresAt),
            });
          }
          transcript.push(
            renderEvent(
              `${request}: create/readiness/echo/destroy passed; fingerprint=${result.fingerprint}`,
            ),
          );
        } else if (driverId === 'local' && inProcessLocalDriver) {
          const connection = echoConnection(request);
          for await (const event of connection.events) transcript.push(renderEvent(event));
          await verified.record(driverId, configurationKeys.get('local') ?? '', {
            fingerprint: 'development-local',
            verifiedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          });
        } else throw new Error(`${driverId} is not available on this runner.`);
        return {
          driverId,
          handle: { id: crypto.randomUUID() },
          transcript,
          destroyed: true as const,
        };
      },
    };
    // `RUNTIME_IMAGE` is read here only for the fingerprint used by `configurationKeys`; whether
    // the *managed* driver's image is actually ready is the runner manager's own concern, not this
    // process's — it validates its own digest at driver construction (`requireDigest` in
    // apps/runner/src/manager-start.ts) and again on every `/verify` round-trip. A deployment where
    // the manager runs as a separate Cloud Run service (unlike a docker-compose setup where both
    // processes share one `.env`) never sets `RUNTIME_IMAGE` on the web container at all, so gating
    // this on a local regex match here always read "not reachable" and made the driver unselectable
    // no matter how healthy the manager was.
    const managedImageReady = runnerManager !== null;
    const entries = [
      ['local', 'This machine (development only)', posture === 'local', posture === 'local'],
      [managedDriverId, managedDriverLabel, runnerManager !== null, managedImageReady],
      ...unavailableRuntimeRegistryEntries(managedDriverId),
    ].map(([id, label, connectionExists, imageReachable]) => {
      const refusal = runtimeNetworkPolicyRefusal(String(id));
      return {
        id: String(id),
        label: String(label),
        connectionExists: connectionExists === true,
        imageReachable: imageReachable === true,
        // Only the managed row can report a pool-fixed policy: it is the one driver this process
        // knows the deployment's own configuration for. The rest stay unrestricted, and the
        // fingerprint in `configurationKeys` deliberately does not see this field — an entry that
        // merely reports what the pool already enforces must not invalidate a verification approval.
        // With no runner manager the policy was never read from the environment, and the row is
        // already `connectionExists: false`, so it reports no restriction rather than a fallback.
        networkPolicies:
          String(id) === managedDriverId && runnerManager !== null
            ? enforceableRuntimeNetworkPolicies(
                managedDriverId,
                verificationNetworkPolicy,
                (process.env['AGENT_WORKSPACE_EGRESS_PROXY_IMAGE']?.trim() ?? '') !== '',
              )
            : null,
        // ADR-0131: shown on the Runtimes screen; the driver still refuses every run itself.
        ...(refusal === null ? {} : { refusal }),
      };
    });
    registryModule.configureWebRuntimeRegistry(
      registryModule.createWebRuntimeRegistry({
        registry,
        entries,
        configFor: (driverId) => ({
          sessionId: crypto.randomUUID(),
          // ENG-07 (#306): a `Test Runtime` probe says which engine's image it is probing, and it
          // must be one this deployment offers: the catalogue's first engine need not have an image.
          // The probe takes the first *installed* engine; a deployment offering a second verifies it
          // by probing again with that engine, which the Runtimes page will ask for once it offers
          // the choice. A deployment offering none sends an empty engine, which the manager refuses.
          engine: registeredEngines().find((candidate) => candidate.installed)?.id ?? '',
          workspacePath: `/tmp/agent-workspace-runtime-tests/${driverId}/${crypto.randomUUID()}`,
        }),
        requestForEcho: String,
        renderEvent: String,
      }),
    );
    log.info(
      `[compose] runtime registry installed: local is development-only; ${managedDriverLabel} uses runner-manager create/readiness/echo/destroy verification (${image})`,
    );
  } catch (error) {
    log.error('[compose] runtime registry NOT installed', { error });
  }
}
