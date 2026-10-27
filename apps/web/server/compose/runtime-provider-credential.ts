import type { RuntimeRunSpec } from '@agent-workspace/runtime/driver';
import type { WorkspaceScopeResolver } from '@agent-workspace/core/db';

import { DomainError } from '../errors';
import {
  resolveRuntimeConnectionCredential,
  type RuntimeConnectionCredentialSecrets,
} from '../runtimes/connections';

/**
 * The part of a run's spec that picks a credential. Test Runtime has no full spec and no runtime
 * profile, so `runtimeProfileId` is absent there and a refusal names the driver instead.
 */
export type ProviderCredentialSpec = Pick<RuntimeRunSpec, 'driver' | 'runtimeConnectionId'> &
  Partial<Pick<RuntimeRunSpec, 'runtimeProfileId'>>;

/** Drivers whose runner-manager driver needs the provider key of a runtime connection (ADR-0120 LC6). */
const PROVIDER_CREDENTIAL_DRIVERS: ReadonlySet<string> = new Set([
  'external',
  'vercel-sandbox',
  'cloudflare-sandbox',
]);

/** Whether `driver` needs a runtime connection holding a provider key. */
export function takesProviderCredential(driver: string): boolean {
  return PROVIDER_CREDENTIAL_DRIVERS.has(driver);
}

function refusal(code: string, message: string): DomainError {
  return new DomainError({
    category: 'validation',
    code,
    publicMessage: `${code}: ${message}`,
  });
}

/**
 * Resolves, server-side and per tenant, the provider credential for one run's spec. Returns
 * `undefined` for a driver that takes none, so nothing is decrypted for it. A missing or unusable
 * connection is a typed refusal naming the connection; no message ever carries the credential.
 */
export function createProviderCredentialResolver(
  dependencies: Readonly<{
    secrets: RuntimeConnectionCredentialSecrets | null;
    scopes: WorkspaceScopeResolver;
  }>,
): (workspaceId: string, spec: ProviderCredentialSpec) => Promise<string | undefined> {
  return async (workspaceId, spec) => {
    if (!takesProviderCredential(spec.driver)) return undefined;
    const connectionId = spec.runtimeConnectionId;
    if (connectionId === undefined) {
      throw refusal(
        'runtime_connection_missing',
        spec.runtimeProfileId === undefined
          ? `Test Runtime of driver ${spec.driver} needs a runtime connection holding its provider key. Create a ${spec.driver} runtime connection and test with it.`
          : `runtime profile ${spec.runtimeProfileId} selects driver ${spec.driver}, which needs a runtime connection holding its provider key. Attach a ${spec.driver} runtime connection to the profile.`,
      );
    }
    const outcome =
      dependencies.secrets === null
        ? ({ kind: 'unusable', name: connectionId } as const)
        : await resolveRuntimeConnectionCredential(
            { secrets: dependencies.secrets, scopes: dependencies.scopes },
            workspaceId,
            connectionId,
            spec.driver,
          );
    switch (outcome.kind) {
      case 'resolved':
        return outcome.credential;
      case 'missing':
        throw refusal(
          'runtime_connection_missing',
          `runtime connection ${connectionId} was not found as a ${spec.driver} connection in this workspace. ${
            spec.runtimeProfileId === undefined
              ? `Test with an existing ${spec.driver} runtime connection.`
              : `Attach an existing ${spec.driver} runtime connection to runtime profile ${spec.runtimeProfileId}.`
          }`,
        );
      case 'unusable':
        throw refusal(
          'runtime_connection_credential_unavailable',
          `runtime connection ${outcome.name} has no usable provider credential. Replace the credential on the connection.`,
        );
    }
  };
}
