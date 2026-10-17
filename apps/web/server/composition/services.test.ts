/**
 * Contract C2 (#441): the runtime registry's `local` driver follows the deployment posture, so a
 * production build started with `AW_DEPLOYMENT_POSTURE=local` offers and verifies it, and a
 * production deployment with no posture still does not.
 *
 * S1-22 (issue #504): under posture `local` the in-process `local` driver counts as verified
 * without a Test Runtime, and `RUNTIME_DRIVER=local` (what `aw dev` starts with) does not let the
 * managed-driver entry take over its verification key or its Test Runtime.
 *
 * #786: under posture `local`, a managed `docker` driver (`aw dev --sandbox docker`) counts as
 * verified too, because the launcher verified it before the web started.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRuntimeManagerClient } from '../compose/runtime-manager-client';
import { clearWebRuntimeRegistry, currentWebRuntimeRegistry } from '../runtimes/registry';
import { installDriverRegistry, type SharedRuntimeVerifications } from './services';

let directory = '';

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aw-services-posture-'));
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('HOST', '127.0.0.1');
  vi.stubEnv('AW_RUNTIME_VERIFICATION_FILE', join(directory, 'verifications.json'));
});

afterEach(() => {
  clearWebRuntimeRegistry();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

async function localEntry() {
  await installDriverRegistry(null, null, 'none');
  const registry = currentWebRuntimeRegistry();
  if (registry === null) throw new Error('the runtime registry was not installed');
  const entries = await registry.list();
  return { registry, entries, local: entries.find((entry) => entry.id === 'local') };
}

describe('installDriverRegistry under a deployment posture', () => {
  it('offers and verifies the local driver for a local-posture production build', async () => {
    vi.stubEnv('AW_DEPLOYMENT_POSTURE', 'local');
    const { registry, local } = await localEntry();
    expect(local).toMatchObject({ connectionExists: true, imageReachable: true, state: 'enabled' });
    const result = await registry.test('local', 'hello');
    expect(result).toEqual({ driverId: 'local', transcript: ['hello'], destroyed: true });
  });

  it('does not offer the local driver under production with no posture', async () => {
    vi.stubEnv('AW_DEPLOYMENT_POSTURE', '');
    const { registry, local } = await localEntry();
    expect(local).toMatchObject({ connectionExists: false, state: 'disabled' });
    await expect(registry.test('local', 'hello')).rejects.toThrow(/not available/u);
  });

  it('fails composition on an invalid posture instead of logging and continuing', async () => {
    vi.stubEnv('AW_DEPLOYMENT_POSTURE', 'prod');
    await expect(installDriverRegistry(null, null, 'none')).rejects.toThrow(
      /AW_DEPLOYMENT_POSTURE/u,
    );
    expect(currentWebRuntimeRegistry()).toBeNull();
  });

  it('fails composition on an unknown RUNTIME_DRIVER instead of reading it as docker', async () => {
    vi.stubEnv('RUNTIME_DRIVER', 'kubernets');
    const failure = await installDriverRegistry(null, null, 'none').then(
      () => null,
      (error: unknown) => error,
    );
    if (!(failure instanceof Error)) throw new Error('composition did not fail');
    expect(failure.message).toMatch(/RUNTIME_DRIVER/u);
    expect(failure.message).not.toContain('kubernets');
    expect(currentWebRuntimeRegistry()).toBeNull();
  });

  it('counts the in-process local driver as verified under posture local, with no Test Runtime (S1-22)', async () => {
    vi.stubEnv('AW_DEPLOYMENT_POSTURE', 'local');
    const { local, entries } = await localEntry();
    expect(local).toMatchObject({ state: 'enabled', testPassed: true });
    // Only the in-process driver: the managed one still needs its own verification.
    expect(entries.find((entry) => entry.id === 'docker')).toMatchObject({ testPassed: false });
  });

  it('counts the managed docker driver as verified under posture local, as aw dev --sandbox docker verified it at start (#786)', async () => {
    const manager = createRuntimeManagerClient('http://127.0.0.1:41000', 'm'.repeat(32), () =>
      Promise.reject(new Error('the registry must not call the runner manager here')),
    );
    const dockerEntry = async () => {
      clearWebRuntimeRegistry();
      await installDriverRegistry(manager, 'http://127.0.0.1:41000', 'open');
      const entries = (await currentWebRuntimeRegistry()?.list()) ?? [];
      return entries.find((entry) => entry.id === 'docker');
    };
    vi.stubEnv('RUNTIME_DRIVER', 'docker');
    vi.stubEnv('AW_DEPLOYMENT_POSTURE', 'local');
    expect(await dockerEntry()).toMatchObject({ state: 'enabled', testPassed: true });
    // A production deployment's docker driver still needs its Test Runtime.
    vi.stubEnv('AW_DEPLOYMENT_POSTURE', '');
    expect(await dockerEntry()).toMatchObject({ testPassed: false });
  });

  it('lists the kubernetes driver once when the runner manager runs it (#854)', async () => {
    const manager = createRuntimeManagerClient('http://127.0.0.1:41000', 'm'.repeat(32), () =>
      Promise.reject(new Error('the registry must not call the runner manager here')),
    );
    vi.stubEnv('RUNTIME_DRIVER', 'kubernetes');
    await installDriverRegistry(manager, 'http://127.0.0.1:41000', 'open');
    const entries = (await currentWebRuntimeRegistry()?.list()) ?? [];
    expect(entries.filter((entry) => entry.id === 'kubernetes')).toHaveLength(1);
    expect(entries.find((entry) => entry.id === 'kubernetes')).toMatchObject({
      connectionExists: true,
    });
  });

  it('lists a disabled Kubernetes row when the runner manager runs docker', async () => {
    const manager = createRuntimeManagerClient('http://127.0.0.1:41000', 'm'.repeat(32), () =>
      Promise.reject(new Error('the registry must not call the runner manager here')),
    );
    vi.stubEnv('RUNTIME_DRIVER', 'docker');
    vi.stubEnv('KUBECONFIG', '/tmp/kubeconfig');
    vi.stubEnv('KUBERNETES_RUNTIME_IMAGE', `registry.example/rt@sha256:${'a'.repeat(64)}`);
    await installDriverRegistry(manager, 'http://127.0.0.1:41000', 'open');
    const entries = (await currentWebRuntimeRegistry()?.list()) ?? [];
    const kubernetes = entries.filter((entry) => entry.id === 'kubernetes');
    expect(kubernetes).toHaveLength(1);
    expect(kubernetes[0]).toMatchObject({
      label: 'Kubernetes',
      connectionExists: false,
      imageReachable: false,
      state: 'disabled',
    });
  });

  it('keeps the local driver in process when RUNTIME_DRIVER=local makes it the managed driver too', async () => {
    vi.stubEnv('AW_DEPLOYMENT_POSTURE', 'local');
    vi.stubEnv('RUNTIME_DRIVER', 'local');
    const { registry, local } = await localEntry();
    expect(local).toMatchObject({ state: 'enabled', testPassed: true });
    // Not "the runner manager is not configured": the managed entry does not take the test over.
    const result = await registry.test('local', 'hello');
    expect(result).toEqual({ driverId: 'local', transcript: ['hello'], destroyed: true });
  });

  it('still needs a Test Runtime under the implicit local posture, whose HOST nobody checked', async () => {
    vi.stubEnv('AW_DEPLOYMENT_POSTURE', '');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('HOST', '0.0.0.0');
    const { registry, local } = await localEntry();
    // The driver is offered, as before S1-22, but not verified until someone runs its test.
    expect(local).toMatchObject({ state: 'enabled', testPassed: false });
    await expect(registry.test('local', 'hello')).resolves.toEqual({
      driverId: 'local',
      transcript: ['hello'],
      destroyed: true,
    });
    const tested = (await registry.list()).find((entry) => entry.id === 'local');
    expect(tested).toMatchObject({ testPassed: true });
  });

  it('verifies a provider driver with a key held in memory, without resolving a runtime connection', async () => {
    const key = 'e2b_test_key_0123456789';
    let sentKey: string | null = null;
    const manager = createRuntimeManagerClient(
      'http://127.0.0.1:41000',
      'm'.repeat(32),
      (_url, init) => {
        sentKey = new Headers(init?.headers).get('X-Provider-Credential');
        return Promise.resolve(
          Response.json({
            fingerprint: 'fp',
            verifiedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        );
      },
    );
    const resolver = vi.fn(() => Promise.reject(new Error('the resolver must not run')));
    vi.stubEnv('RUNTIME_DRIVER', 'external');
    await installDriverRegistry(manager, 'http://127.0.0.1:41000', 'open', resolver);
    const registry = currentWebRuntimeRegistry();
    if (registry === null) throw new Error('the runtime registry was not installed');
    const result = await registry.test('external', 'hello', {
      workspaceId: 'workspace-a',
      providerCredential: key,
    });
    expect(result.destroyed).toBe(true);
    expect(sentKey).toBe(key);
    expect(resolver).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it('counts a Test Runtime pass recorded on another instance of the same workspace (issue #827)', async () => {
    const shared = new Map<string, { configurationKey: string; expiresAt: Date }>();
    const sharedVerifications: SharedRuntimeVerifications = {
      get: (workspaceId, driverId) =>
        Promise.resolve(shared.get(`${workspaceId}/${driverId}`) ?? null),
      record: (workspaceId, driverId, verification) => {
        shared.set(`${workspaceId}/${driverId}`, verification);
        return Promise.resolve();
      },
    };
    const manager = createRuntimeManagerClient('http://127.0.0.1:41000', 'm'.repeat(32), () =>
      Promise.resolve(
        Response.json({
          fingerprint: 'fp',
          verifiedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      ),
    );
    vi.stubEnv('RUNTIME_DRIVER', 'external');
    const passFor = async (workspaceId: string | undefined): Promise<boolean | undefined> =>
      (await currentWebRuntimeRegistry()?.list(workspaceId))?.find(
        (entry) => entry.id === 'external',
      )?.testPassed;
    const installInstance = async (name: string, shareWith?: SharedRuntimeVerifications) => {
      vi.stubEnv('AW_RUNTIME_VERIFICATION_FILE', join(directory, `${name}.json`));
      await installDriverRegistry(manager, 'http://127.0.0.1:41000', 'open', undefined, shareWith);
    };

    await installInstance('instance-a', sharedVerifications);
    await currentWebRuntimeRegistry()?.test('external', 'hello', {
      workspaceId: 'workspace-a',
      providerCredential: 'e2b_test_key_0123456789',
    });
    await expect(passFor('workspace-a')).resolves.toBe(true);

    // A second function instance has its own, empty verification file.
    await installInstance('instance-b', sharedVerifications);
    await expect(passFor('workspace-a')).resolves.toBe(true);
    await expect(passFor('workspace-b')).resolves.toBe(false);
    await expect(passFor(undefined)).resolves.toBe(false);

    // Without the shared record, the pass stays on the instance that ran the test.
    await installInstance('instance-c');
    await expect(passFor('workspace-a')).resolves.toBe(false);
  });

  it('refuses a shared Test Runtime pass that expired or was made for another configuration', async () => {
    const recorded: Array<{ configurationKey: string; expiresAt: Date }> = [];
    const manager = createRuntimeManagerClient('http://127.0.0.1:41000', 'm'.repeat(32), () =>
      Promise.resolve(
        Response.json({
          fingerprint: 'fp',
          verifiedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      ),
    );
    vi.stubEnv('RUNTIME_DRIVER', 'external');
    vi.stubEnv('AW_RUNTIME_VERIFICATION_FILE', join(directory, 'tested.json'));
    await installDriverRegistry(manager, 'http://127.0.0.1:41000', 'open', undefined, {
      get: () => Promise.resolve(null),
      record: (_workspaceId, _driverId, verification) => {
        recorded.push(verification);
        return Promise.resolve();
      },
    });
    await currentWebRuntimeRegistry()?.test('external', 'hello', {
      workspaceId: 'workspace-a',
      providerCredential: 'e2b_test_key_0123456789',
    });
    const own = recorded[0];
    if (own === undefined) throw new Error('Test Runtime recorded no shared pass');

    const passWith = async (stored: { configurationKey: string; expiresAt: Date }) => {
      vi.stubEnv('AW_RUNTIME_VERIFICATION_FILE', join(directory, `${crypto.randomUUID()}.json`));
      await installDriverRegistry(manager, 'http://127.0.0.1:41000', 'open', undefined, {
        get: () => Promise.resolve(stored),
        record: () => Promise.resolve(),
      });
      const entries = (await currentWebRuntimeRegistry()?.list('workspace-a')) ?? [];
      return entries.find((entry) => entry.id === 'external')?.testPassed;
    };

    expect(await passWith(own)).toBe(true);
    expect(await passWith({ ...own, configurationKey: 'another-configuration' })).toBe(false);
    expect(await passWith({ ...own, expiresAt: new Date(Date.now() - 1) })).toBe(false);
  });

  it('fails closed when the shared Test Runtime store cannot be read', async () => {
    const manager = createRuntimeManagerClient('http://127.0.0.1:41000', 'm'.repeat(32), () =>
      Promise.reject(new Error('the registry must not call the runner manager here')),
    );
    vi.stubEnv('RUNTIME_DRIVER', 'external');
    vi.stubEnv('AW_RUNTIME_VERIFICATION_FILE', join(directory, 'untested.json'));
    await installDriverRegistry(manager, 'http://127.0.0.1:41000', 'open', undefined, {
      get: () => Promise.reject(new Error('db down')),
      record: () => Promise.resolve(),
    });
    await expect(currentWebRuntimeRegistry()?.list('workspace-a')).rejects.toThrow('db down');
  });

  it('never counts the local driver as verified under production', async () => {
    for (const driver of ['', 'local']) {
      clearWebRuntimeRegistry();
      vi.stubEnv('AW_DEPLOYMENT_POSTURE', '');
      vi.stubEnv('RUNTIME_DRIVER', driver);
      const { local } = await localEntry();
      expect(local, `RUNTIME_DRIVER=${driver}`).toMatchObject({ testPassed: false });
    }
  });
});
