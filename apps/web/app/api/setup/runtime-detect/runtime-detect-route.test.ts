/**
 * `GET /api/setup/runtime-detect` reports what this deployment can run (issue #378): the Docker
 * Compose topology — a runner manager on the `docker` driver — defaults to `docker` and offers it
 * once the manager answers; every other topology keeps defaulting to `local`; a manager that does
 * not answer is never reported as available; and the public route does not turn every anonymous
 * request into a runner-manager probe.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearWebRuntimeRegistry,
  configureWebRuntimeRegistry,
  type RuntimeRegistryEntry,
} from '../../../../server/runtimes/registry';
import {
  clearSetupRuntimeDetection,
  configureSetupRuntimeDetection,
  currentSetupRuntimeDetection,
  setupRuntimeDetectionInputs,
} from '../../../../server/setup/runtime-detection';

import { GET } from './route';

const MANAGER_URL = 'http://runner:8090';

function entry(id: string, enabled: boolean): RuntimeRegistryEntry {
  return {
    id,
    label: id,
    connectionExists: enabled,
    imageReachable: enabled,
    testPassed: false,
    state: enabled ? 'enabled' : 'disabled',
    reason: enabled ? null : 'No runtime connection is configured.',
    networkPolicies: null,
  };
}

function installRegistry(entries: readonly RuntimeRegistryEntry[]): void {
  configureWebRuntimeRegistry({
    list: () => Promise.resolve(entries),
    test: () => Promise.reject(new Error('detection must not run a runtime test')),
  });
}

/** Installs detection the way the composition root does, with a stub health check. */
function installDetection(
  runnerManagerUrl: string | null,
  managedDriverId: string,
  healthy: boolean | Error,
) {
  const probe = vi.fn<(url: string) => Promise<boolean>>(() =>
    healthy instanceof Error ? Promise.reject(healthy) : Promise.resolve(healthy),
  );
  configureSetupRuntimeDetection(
    setupRuntimeDetectionInputs(runnerManagerUrl, managedDriverId, probe),
  );
  return probe;
}

type Detection = {
  defaultDriver: string;
  drivers: { id: string; available: boolean; reason: string }[];
};

async function detect(): Promise<Detection> {
  const response = await GET();
  expect(response.status).toBe(200);
  return (await response.json()) as Detection;
}

function driver(detection: Detection, id: string) {
  return detection.drivers.find((candidate) => candidate.id === id);
}

afterEach(() => {
  clearWebRuntimeRegistry();
  clearSetupRuntimeDetection();
});

describe('GET /api/setup/runtime-detect', () => {
  it('defaults the Docker Compose topology to an available docker driver', async () => {
    installRegistry([entry('local', false), entry('docker', true)]);
    const probe = installDetection(MANAGER_URL, 'docker', true);

    const detection = await detect();

    expect(detection.defaultDriver).toBe('docker');
    expect(driver(detection, 'docker')).toMatchObject({ available: true });
    expect(driver(detection, 'local')).toMatchObject({ available: false });
    expect(probe).toHaveBeenCalledExactlyOnceWith(MANAGER_URL);
  });

  it('keeps the local topology on the local driver without probing any runner manager', async () => {
    installRegistry([entry('local', true), entry('docker', false)]);
    const probe = installDetection(null, 'docker', true);

    const detection = await detect();

    expect(detection.defaultDriver).toBe('local');
    expect(driver(detection, 'local')).toMatchObject({ available: true });
    expect(driver(detection, 'docker')).toMatchObject({ available: false });
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not claim docker is available when the runner manager is unreachable', async () => {
    installRegistry([entry('local', false), entry('docker', true)]);
    installDetection(MANAGER_URL, 'docker', false);

    const detection = await detect();

    expect(detection.defaultDriver).toBe('docker');
    const docker = driver(detection, 'docker');
    expect(docker?.available).toBe(false);
    expect(docker?.reason).toMatch(/runner manager did not answer/u);
  });

  it('does not claim docker is available when the health check itself throws', async () => {
    installRegistry([entry('local', false), entry('docker', true)]);
    installDetection(MANAGER_URL, 'docker', new TypeError('fetch failed'));

    expect(driver(await detect(), 'docker')?.available).toBe(false);
  });

  it('does not probe or offer docker when the registry disables its row', async () => {
    installRegistry([entry('local', false), entry('docker', false)]);
    const probe = installDetection(MANAGER_URL, 'docker', true);

    const detection = await detect();

    expect(driver(detection, 'docker')).toEqual({
      id: 'docker',
      available: false,
      reason: 'No runtime connection is configured.',
    });
    expect(driver(detection, 'local')?.reason).toMatch(/development only/u);
    expect(probe).not.toHaveBeenCalled();
  });

  it('keeps defaulting to local when the runner manager runs a driver other than docker', async () => {
    installRegistry([entry('local', true), entry('cloud-run-service', true)]);
    const probe = installDetection(MANAGER_URL, 'cloud-run-service', true);

    const detection = await detect();

    expect(detection.defaultDriver).toBe('local');
    expect(driver(detection, 'docker')).toMatchObject({ available: false });
    expect(probe).not.toHaveBeenCalled();
  });

  it('reports nothing available when no runtime registry is installed', async () => {
    const probe = installDetection(MANAGER_URL, 'docker', true);

    const detection = await detect();

    expect(detection.drivers.every(({ available }) => !available)).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it('answers the local default before the composition has installed detection', async () => {
    installRegistry([entry('local', true)]);

    expect((await detect()).defaultDriver).toBe('local');
  });
});

describe('setup runtime detection cache', () => {
  it('reuses one probe for requests within a few seconds, then probes again', async () => {
    installRegistry([entry('docker', true)]);
    const probe = installDetection(MANAGER_URL, 'docker', true);
    const start = 1_000_000;

    await Promise.all([
      currentSetupRuntimeDetection(start),
      currentSetupRuntimeDetection(start),
      currentSetupRuntimeDetection(start + 4_000),
    ]);
    expect(probe).toHaveBeenCalledOnce();

    await currentSetupRuntimeDetection(start + 5_000);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failed detection for the next request', async () => {
    configureWebRuntimeRegistry({
      list: vi
        .fn<() => Promise<readonly RuntimeRegistryEntry[]>>()
        .mockRejectedValueOnce(new Error('registry unavailable'))
        .mockResolvedValue([entry('docker', true)]),
      test: () => Promise.reject(new Error('detection must not run a runtime test')),
    });
    installDetection(MANAGER_URL, 'docker', true);

    await expect(currentSetupRuntimeDetection(0)).rejects.toThrow('registry unavailable');
    const detection = await currentSetupRuntimeDetection(1);
    expect(detection.drivers.find(({ id }) => id === 'docker')?.available).toBe(true);
  });
});
