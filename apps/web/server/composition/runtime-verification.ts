import type { RuntimeDriverId } from '@agent-workspace/run-protocol';

import type { RuntimeManagerClient } from '../compose/runtime-manager-client';
import type { ProviderCredentialSpec } from '../compose/runtime-provider-credential';
import type { RuntimeProbeConfig, TestableDriverRegistry } from '../runtimes/registry';
import type { RuntimeVerificationCache } from '../runtimes/verification-store';

/** A workspace's passing Test Runtime, shared by every instance serving it. */
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

interface RuntimeVerificationOptions {
  readonly managedDriverId: RuntimeDriverId;
  readonly inProcessLocalDriver: boolean;
  readonly verifiedWithoutTest: boolean;
  readonly runnerManager: RuntimeManagerClient | null;
  readonly configurationKeys: ReadonlyMap<string, string>;
  readonly verified: RuntimeVerificationCache;
  readonly sharedVerifications: SharedRuntimeVerifications | undefined;
  readonly resolveProviderCredential:
    | ((workspaceId: string, spec: ProviderCredentialSpec) => Promise<string | undefined>)
    | undefined;
}

function echoConnection(value: string) {
  return {
    events: (async function* () {
      await Promise.resolve();
      yield value;
    })(),
    sessionId: Promise.resolve(crypto.randomUUID()),
    interrupt: () => Promise.resolve(),
  };
}

async function verifyManagedDriver(
  options: RuntimeVerificationOptions,
  config: RuntimeProbeConfig,
): Promise<string> {
  const {
    runnerManager,
    managedDriverId,
    resolveProviderCredential,
    verified,
    sharedVerifications,
  } = options;
  if (runnerManager === null) throw new Error('the runner manager is not configured');
  // The workspace comes from the caller's session, never from a request body.
  const providerCredential =
    config.providerCredential ??
    (resolveProviderCredential === undefined || config.workspaceId === undefined
      ? undefined
      : await resolveProviderCredential(config.workspaceId, {
          driver: managedDriverId,
          ...(config.runtimeConnectionId === undefined
            ? {}
            : { runtimeConnectionId: config.runtimeConnectionId }),
        }));
  const result = await runnerManager.verify(config, managedDriverId, providerCredential);
  const expiresAt = Date.parse(result.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error('the runner manager returned an expired verification');
  }
  const configurationKey = options.configurationKeys.get(managedDriverId) ?? '';
  await verified.record(managedDriverId, configurationKey, result);
  if (sharedVerifications !== undefined && config.workspaceId !== undefined) {
    await sharedVerifications.record(config.workspaceId, managedDriverId, {
      configurationKey,
      fingerprint: result.fingerprint,
      verifiedAt: new Date(result.verifiedAt),
      expiresAt: new Date(expiresAt),
    });
  }
  return result.fingerprint;
}

export function createRuntimeVerificationRegistry(
  options: RuntimeVerificationOptions,
): TestableDriverRegistry<string, string> {
  const {
    managedDriverId,
    inProcessLocalDriver,
    verifiedWithoutTest,
    verified,
    sharedVerifications,
  } = options;
  return {
    async wasVerified(driverId, workspaceId) {
      if (verifiedWithoutTest && driverId === 'local') return true;
      // aw dev --sandbox docker verifies its manager before starting this process.
      if (
        verifiedWithoutTest &&
        driverId === 'docker' &&
        managedDriverId === 'docker' &&
        options.runnerManager !== null
      )
        return true;
      const configurationKey = options.configurationKeys.get(driverId);
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
    // A lapsed pass is renewed by the run that finds it, preserving the first-test requirement.
    async hasPassed(driverId, workspaceId) {
      return (
        verified.hasPassed(driverId) ||
        (sharedVerifications !== undefined &&
          (await sharedVerifications.get(workspaceId, driverId)) !== null)
      );
    },
    async test(driverId, config, request, renderEvent) {
      const transcript: string[] = [];
      if (driverId === managedDriverId && !(inProcessLocalDriver && driverId === 'local')) {
        const fingerprint = await verifyManagedDriver(options, config);
        transcript.push(
          renderEvent(
            `${request}: create/readiness/echo/destroy passed; fingerprint=${fingerprint}`,
          ),
        );
      } else if (driverId === 'local' && inProcessLocalDriver) {
        const connection = echoConnection(request);
        for await (const event of connection.events) transcript.push(renderEvent(event));
        await verified.record(driverId, options.configurationKeys.get('local') ?? '', {
          fingerprint: 'development-local',
          verifiedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
      } else throw new Error(`${driverId} is not available on this runner.`);
      return { driverId, handle: { id: crypto.randomUUID() }, transcript, destroyed: true };
    },
  };
}
