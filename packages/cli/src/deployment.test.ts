import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertComposeProjectName,
  assertDigestReference,
  assertDigestReferences,
  parseEnvironment,
  resolveDeploymentImages,
  resolveEgressProxyImage,
  resolveToolHostImage,
  validateDeploymentEnvironment,
} from './deployment.js';
import { platformImageTag } from './release-images.js';

const childProcess = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

vi.mock('node:child_process', () => childProcess);

const ref = (name: string, digit: string) => `registry.example/${name}@sha256:${digit.repeat(64)}`;

describe('the sandbox egress proxy image', () => {
  const environment = {
    AW_WEB_IMAGE: ref('web', '1'),
    AW_GATEWAY_IMAGE: ref('gateway', '2'),
    AW_RUNNER_IMAGE: ref('runner', '3'),
    AW_RUNTIME_IMAGE: ref('runtime', '4'),
  };

  beforeEach(() => {
    childProcess.spawnSync.mockReset();
  });

  it.each(['gcp', 'aws', 'azure', 'local'] as const)(
    'is not resolved for the %s shape by default',
    (cloud) => {
      const images = resolveDeploymentImages(cloud, {
        ...environment,
        AW_POSTGRES_IMAGE: ref('postgres', '5'),
        AW_SEAWEEDFS_IMAGE: ref('seaweedfs', '6'),
      });
      expect(images).not.toHaveProperty('egressProxy');
      expect(childProcess.spawnSync).not.toHaveBeenCalled();
    },
  );

  it('is carried by a gcp set only when an override or a pin supplies it', () => {
    const override = ref('egress-proxy', '8');
    expect(
      resolveDeploymentImages('gcp', { ...environment, AW_EGRESS_PROXY_IMAGE: override })
        .egressProxy,
    ).toBe(override);
    expect(
      resolveDeploymentImages('gcp', environment, { egressProxy: ref('egress-proxy', '9') })
        .egressProxy,
    ).toBe(ref('egress-proxy', '9'));
    expect(
      resolveDeploymentImages('aws', { ...environment, AW_EGRESS_PROXY_IMAGE: override }),
    ).not.toHaveProperty('egressProxy');
  });

  it('resolves an override, then a pin, then the release tag, through the digest gate', () => {
    const override = ref('egress-proxy', '8');
    const pin = ref('egress-proxy', '9');
    expect(resolveEgressProxyImage({ AW_EGRESS_PROXY_IMAGE: override }, pin)).toBe(override);
    expect(resolveEgressProxyImage({}, pin)).toBe(pin);
    expect(childProcess.spawnSync).not.toHaveBeenCalled();

    childProcess.spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ digest: `sha256:${'a'.repeat(64)}` }),
      stderr: '',
    });
    expect(resolveEgressProxyImage({})).toMatch(/\/egress-proxy@sha256:a{64}$/u);
    expect(childProcess.spawnSync.mock.calls[0]?.[1]).toContain(platformImageTag('egressProxy'));
    expect(() => resolveEgressProxyImage({}, 'registry.example/egress-proxy:latest')).toThrow(
      'the pinned egressProxy image must be a non-placeholder sha256 digest reference',
    );
  });
});

describe('the tool-host image', () => {
  const environment = {
    AW_WEB_IMAGE: ref('web', '1'),
    AW_GATEWAY_IMAGE: ref('gateway', '2'),
    AW_RUNNER_IMAGE: ref('runner', '3'),
    AW_RUNTIME_IMAGE: ref('runtime', '4'),
  };

  beforeEach(() => {
    childProcess.spawnSync.mockReset();
  });

  it('is carried by a gcp set only when AW_TOOL_HOST_IMAGE or a pin supplies it', () => {
    const override = ref('tool-host', '8');
    expect(resolveDeploymentImages('gcp', environment)).not.toHaveProperty('toolHost');
    expect(
      resolveDeploymentImages('gcp', { ...environment, AW_TOOL_HOST_IMAGE: override }).toolHost,
    ).toBe(override);
    expect(
      resolveDeploymentImages('gcp', environment, { toolHost: ref('tool-host', '9') }).toolHost,
    ).toBe(ref('tool-host', '9'));
    expect(
      resolveDeploymentImages('local', {
        ...environment,
        AW_TOOL_HOST_IMAGE: override,
        AW_POSTGRES_IMAGE: ref('postgres', '5'),
        AW_SEAWEEDFS_IMAGE: ref('seaweedfs', '6'),
      }),
    ).not.toHaveProperty('toolHost');
  });

  it('resolves an override, then a pin, then the release tag, through the digest gate', () => {
    const override = ref('tool-host', '8');
    const pin = ref('tool-host', '9');
    expect(resolveToolHostImage({ AW_TOOL_HOST_IMAGE: override }, pin)).toBe(override);
    expect(resolveToolHostImage({}, pin)).toBe(pin);
    expect(childProcess.spawnSync).not.toHaveBeenCalled();

    childProcess.spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ digest: `sha256:${'a'.repeat(64)}` }),
      stderr: '',
    });
    expect(resolveToolHostImage({})).toMatch(/\/tool-host@sha256:a{64}$/u);
    expect(childProcess.spawnSync.mock.calls[0]?.[1]).toContain(platformImageTag('toolHost'));
    expect(() => resolveToolHostImage({}, 'registry.example/tool-host:latest')).toThrow(
      'the pinned toolHost image must be a non-placeholder sha256 digest reference',
    );
  });
});

// `agent-workspace render` passes the project's own `.env` pins: an override still wins, a pin
// is used without a registry, and a pin that is not a digest is refused by name, not by value.
describe('with pinned references', () => {
  const pinned = {
    web: ref('web', '1'),
    gateway: ref('gateway', '2'),
    runner: ref('runner', '3'),
    runtime: ref('runtime', '4'),
  };

  beforeEach(() => {
    childProcess.spawnSync.mockReset();
  });

  it('uses every pin without spawning docker', () => {
    expect(resolveDeploymentImages('gcp', {}, pinned)).toEqual(pinned);
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it('lets an override beat a pin', () => {
    const override = ref('web', '9');
    expect(resolveDeploymentImages('gcp', { AW_WEB_IMAGE: override }, pinned).web).toBe(override);
  });

  it('refuses a placeholder pin without quoting it', () => {
    const placeholder = `registry.example/web@sha256:${'0'.repeat(64)}`;
    expect(() => resolveDeploymentImages('gcp', {}, { ...pinned, web: placeholder })).toThrow(
      'the pinned web image must be a non-placeholder sha256 digest reference',
    );
  });
});

const platformPins = [
  `WEB_IMAGE=${ref('web', '1')}`,
  `GATEWAY_IMAGE=${ref('gateway', '2')}`,
  `RUNNER_IMAGE=${ref('runner', '3')}`,
  `RUNTIME_IMAGE=${ref('runtime', '4')}`,
  `POSTGRES_IMAGE=${ref('postgres', '5')}`,
  'RUNTIME_DRIVER=docker',
];

const environmentOf = (...lines: string[]) =>
  parseEnvironment([...platformPins, ...lines].join('\n'));
describe('deployment image contract', () => {
  it('accepts immutable references and rejects tags and placeholder digests', () => {
    expect(assertDigestReference(ref('web', 'a'))).toContain('@sha256:');
    expect(() => assertDigestReference('registry.example/web:latest')).toThrow(/sha256/u);
    expect(() => assertDigestReference(`registry.example/web@sha256:${'0'.repeat(64)}`)).toThrow(
      /placeholder/u,
    );
  });

  it('resolves already-pinned environment overrides without registry access', () => {
    const environment = {
      AW_WEB_IMAGE: ref('web', '1'),
      AW_GATEWAY_IMAGE: ref('gateway', '2'),
      AW_RUNNER_IMAGE: ref('runner', '3'),
      AW_RUNTIME_IMAGE: ref('runtime', '4'),
      AW_POSTGRES_IMAGE: ref('postgres', '5'),
      AW_SEAWEEDFS_IMAGE: ref('seaweedfs', '6'),
    };
    expect(resolveDeploymentImages('local', environment)).toEqual({
      web: environment.AW_WEB_IMAGE,
      gateway: environment.AW_GATEWAY_IMAGE,
      runner: environment.AW_RUNNER_IMAGE,
      runtime: environment.AW_RUNTIME_IMAGE,
      postgres: environment.AW_POSTGRES_IMAGE,
      seaweedfs: environment.AW_SEAWEEDFS_IMAGE,
    });
  });

  // PostgreSQL and SeaweedFS are Compose services. A cloud deployment takes its database and its
  // bucket from the cloud, so requiring those two pins would gate an image it never pulls — and
  // would send the generator to a registry for it.
  it('resolves and gates only the images the named deployment shape pulls', () => {
    const environment = {
      AW_WEB_IMAGE: ref('web', '1'),
      AW_GATEWAY_IMAGE: ref('gateway', '2'),
      AW_RUNNER_IMAGE: ref('runner', '3'),
      AW_RUNTIME_IMAGE: ref('runtime', '4'),
    };
    const cloudImages = resolveDeploymentImages('gcp', environment);
    expect(cloudImages).toEqual({
      web: environment.AW_WEB_IMAGE,
      gateway: environment.AW_GATEWAY_IMAGE,
      runner: environment.AW_RUNNER_IMAGE,
      runtime: environment.AW_RUNTIME_IMAGE,
    });
    expect(assertDigestReferences(cloudImages)).toBe(cloudImages);
    // Whatever is in the set still clears the gate.
    expect(() =>
      assertDigestReferences({ ...cloudImages, postgres: 'docker.io/library/postgres:18-alpine' }),
    ).toThrow(/sha256/u);
  });
});

describe('bundled object-store image selection', () => {
  // ADR-0067: the bundled object store is SeaweedFS. The MinIO-era override is refused by name
  // rather than ignored, so a release script still setting it learns why its pin went nowhere.
  it('refuses the retired MinIO image override for the Compose project', () => {
    const environment = {
      AW_WEB_IMAGE: ref('web', '1'),
      AW_GATEWAY_IMAGE: ref('gateway', '2'),
      AW_RUNNER_IMAGE: ref('runner', '3'),
      AW_RUNTIME_IMAGE: ref('runtime', '4'),
      AW_POSTGRES_IMAGE: ref('postgres', '5'),
      AW_MINIO_IMAGE: ref('minio', '6'),
    };
    expect(() => resolveDeploymentImages('local', environment)).toThrow(
      /AW_MINIO_IMAGE is no longer read.*AW_SEAWEEDFS_IMAGE/u,
    );
  });

  it('pins the bundled object store to the digest the S3 contract suite runs against', () => {
    const environment = {
      AW_WEB_IMAGE: ref('web', '1'),
      AW_GATEWAY_IMAGE: ref('gateway', '2'),
      AW_RUNNER_IMAGE: ref('runner', '3'),
      AW_RUNTIME_IMAGE: ref('runtime', '4'),
      AW_POSTGRES_IMAGE: ref('postgres', '5'),
    };
    expect(resolveDeploymentImages('local', environment).seaweedfs).toBe(
      'docker.io/chrislusf/seaweedfs@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882',
    );
  });
});

describe('runtime image compatibility', () => {
  it('fails when configured and effective runtime topology disagree', () => {
    const environment = parseEnvironment(
      [
        `WEB_IMAGE=${ref('web', '1')}`,
        `GATEWAY_IMAGE=${ref('gateway', '2')}`,
        `RUNNER_IMAGE=${ref('runner', '3')}`,
        `RUNTIME_IMAGE=${ref('runtime', '4')}`,
        `POSTGRES_IMAGE=${ref('postgres', '5')}`,
        `SEAWEEDFS_IMAGE=${ref('seaweedfs', '6')}`,
        'RUNTIME_DRIVER=local',
      ].join('\n'),
    );
    expect(() => validateDeploymentEnvironment(environment)).toThrow(/disagrees/u);
  });

  // ENG-07 (ADR-0073): a project generated since pins the Claude engine's runtime image under its
  // per-engine variable; one generated before pins RUNTIME_IMAGE (the `platformPins` above). Both
  // clear the same digest gate.
  it('gates the per-engine runtime image pin and still accepts the pre-ENG-07 one', () => {
    const current = (runtime: string) =>
      parseEnvironment(
        [
          ...platformPins.filter((line) => !line.startsWith('RUNTIME_IMAGE=')),
          `AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK=${runtime}`,
          `SEAWEEDFS_IMAGE=${ref('seaweedfs', '6')}`,
        ].join('\n'),
      );
    expect(() => validateDeploymentEnvironment(current(ref('runtime', '4')))).not.toThrow();
    expect(() => validateDeploymentEnvironment(current('registry.example/runtime:latest'))).toThrow(
      /AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK must be a non-placeholder sha256 digest/u,
    );
    expect(() =>
      validateDeploymentEnvironment(environmentOf(`SEAWEEDFS_IMAGE=${ref('seaweedfs', '6')}`)),
    ).not.toThrow();
  });
});

describe('Compose project names', () => {
  /** #394: the project name labels sandboxes and scopes the session cookie; refuse a bad one up front. */
  it('refuses an invalid, too-long or reserved COMPOSE_PROJECT_NAME before starting', () => {
    const seaweed = `SEAWEEDFS_IMAGE=${ref('seaweedfs', '6')}`;
    expect(() =>
      validateDeploymentEnvironment(environmentOf(seaweed, 'COMPOSE_PROJECT_NAME=acme-ai')),
    ).not.toThrow();
    expect(() =>
      validateDeploymentEnvironment(environmentOf(seaweed, 'COMPOSE_PROJECT_NAME=Acme AI')),
    ).toThrow(/is not a Compose project name/u);
    expect(() =>
      validateDeploymentEnvironment(
        environmentOf(seaweed, `COMPOSE_PROJECT_NAME=${'a'.repeat(64)}`),
      ),
    ).toThrow(/64 characters long.*session cookie/su);
    expect(() =>
      validateDeploymentEnvironment(environmentOf(seaweed, 'COMPOSE_PROJECT_NAME=agent-workspace')),
    ).toThrow(/reserved/u);
    expect(assertComposeProjectName('a'.repeat(63))).toBe('a'.repeat(63));
  });

  /** #496: an empty name is how a kind: Project directory with a hand-written .env reaches this. */
  it('tells a refused COMPOSE_PROJECT_NAME where a Compose project comes from and about aw dev', () => {
    expect(() => assertComposeProjectName('')).toThrow(
      'the name `npm create @indx-workspace <directory> -- --cloud local` generated',
    );
    expect(() => assertComposeProjectName('')).toThrow(
      'A kind: Project directory runs with `aw dev`',
    );
    expect(() => assertComposeProjectName(undefined)).not.toThrow(/create-agent-workspace/u);
  });
});

describe('object-store image compatibility', () => {
  it('holds the object-store pin to the digest gate', () => {
    expect(() =>
      validateDeploymentEnvironment(environmentOf(`SEAWEEDFS_IMAGE=${ref('seaweedfs', '6')}`)),
    ).not.toThrow();
    expect(() =>
      validateDeploymentEnvironment(
        environmentOf('SEAWEEDFS_IMAGE=docker.io/chrislusf/seaweedfs:4.47'),
      ),
    ).toThrow(/SEAWEEDFS_IMAGE must be a non-placeholder sha256 digest/u);
    expect(() => validateDeploymentEnvironment(environmentOf())).toThrow(
      /SEAWEEDFS_IMAGE must be/u,
    );
  });

  // A project generated before ADR-0067 carries its own MinIO-era compose.yaml and pins
  // MINIO_IMAGE; `start` still holds that pin to the same gate instead of refusing the project.
  it('still gates the MinIO pin of a project generated before the SeaweedFS switch', () => {
    expect(() =>
      validateDeploymentEnvironment(environmentOf(`MINIO_IMAGE=${ref('minio', '6')}`)),
    ).not.toThrow();
    expect(() =>
      validateDeploymentEnvironment(environmentOf('MINIO_IMAGE=minio/minio:RELEASE.2025-09-07')),
    ).toThrow(/MINIO_IMAGE must be a non-placeholder sha256 digest/u);
  });
});
