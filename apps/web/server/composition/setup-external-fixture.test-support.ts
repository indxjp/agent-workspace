import { afterEach, beforeEach } from 'vitest';
import { DomainError } from '../errors';
import { resolveRuntimeConnectionCredential } from '../runtimes/connections';
import { configureWebRuntimeRegistry } from '../runtimes/registry';
import {
  db,
  E2B_ENDPOINT,
  E2B_KEY,
  install,
  LOCAL_REGISTRY,
  runtimeSecrets,
  scope,
  workspace,
} from './setup-fixture.test-support';
export const EXTERNAL = {
  runtime: 'external',
  runtimeCredential: E2B_KEY,
  runtimeEndpoint: E2B_ENDPOINT,
};

/** The keys the registry was asked to test with; like the real one it refuses without a key. */
export const testedWith: (string | undefined)[] = [];

function useExternalRegistry(): void {
  testedWith.length = 0;
  configureWebRuntimeRegistry({
    list: () =>
      Promise.resolve([
        {
          id: 'external',
          label: 'External provider',
          connectionExists: true,
          imageReachable: true,
          testPassed: true,
          state: 'enabled',
          reason: null,
          networkPolicies: null,
        },
      ]),
    test: (driverId, _echo, testScope) => {
      testedWith.push(testScope?.providerCredential);
      if (testScope?.providerCredential === undefined) {
        return Promise.reject(
          new DomainError({
            category: 'validation',
            code: 'runtime_connection_missing',
            publicMessage:
              'runtime_connection_missing: Test Runtime of driver external needs a runtime connection.',
          }),
        );
      }
      return Promise.resolve({ driverId, transcript: [], destroyed: true });
    },
  });
}

export async function runtimeConnectionNames(): Promise<readonly string[]> {
  return (await runtimeSecrets.list(scope()))
    .map((secret) => secret.name)
    .filter((name) => name.startsWith('RUNTIME_CONNECTION__'));
}

export async function storedKey(connectionId: string): Promise<string | null> {
  const outcome = await resolveRuntimeConnectionCredential(
    { secrets: runtimeSecrets, scopes: db().scopes },
    workspace.id,
    connectionId,
    'external',
  );
  return outcome.kind === 'resolved' ? outcome.credential : null;
}
export function registerExternalFixture(): void {
  beforeEach(useExternalRegistry);
  afterEach(async () => {
    configureWebRuntimeRegistry(LOCAL_REGISTRY);
    await install(db());
  });
}
