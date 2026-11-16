import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync,
}));

import { resolveDeploymentImages } from './deployment.ts';
import { REGISTRY_RETRY, isTransientRegistryFailure } from './deployment-images.ts';
import document from './release-images.json' with { type: 'json' };
import {
  PLATFORM_IMAGE_VERSION,
  PLATFORM_IMAGES_WORKFLOW,
  PLATFORM_IMAGE_SIGNER,
  PLATFORM_IMAGES_PINNED,
  parseRelease,
  platformImageReference,
  platformImageTag,
} from './release-images.ts';

const digest = (digit: string) => `sha256:${digit.repeat(64)}`;

describe('the platform image release list (#370)', () => {
  beforeEach(() => spawnSync.mockReset());

  it('names every platform image under <registry>/agent-workspace at the release version', () => {
    expect(platformImageTag('web')).toBe(
      `${document.registry}/agent-workspace/${document.images.web}:${document.version}`,
    );
    expect(platformImageTag('runtime')).toBe(
      `${document.registry}/agent-workspace/${document.images.runtime}:${document.version}`,
    );
    expect(platformImageTag('egressProxy')).toBe(
      `${document.registry}/agent-workspace/${document.images.egressProxy}:${document.version}`,
    );
    expect(PLATFORM_IMAGE_VERSION).toBe(document.version);
  });

  it('resolves the default references from the list, and only through a digest', () => {
    const inspected: string[] = [];
    spawnSync.mockImplementation((_command: string, args?: readonly string[]) => {
      if (args?.[0] === 'buildx') inspected.push(String(args[3]));
      return { status: 0, stdout: JSON.stringify({ digest: digest('a') }), stderr: '' };
    });
    const images = resolveDeploymentImages('aws', {});
    expect(inspected).toEqual([
      platformImageTag('web'),
      platformImageTag('gateway'),
      platformImageTag('runner'),
      platformImageTag('runtime'),
    ]);
    expect(images.web).toBe(`${document.registry}/agent-workspace/web@${digest('a')}`);
  });

  it('refuses an unpublished release and names the tag and the workflow that publish it', () => {
    spawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'unexpected status: 403 Forbidden',
    });
    let message = '';
    try {
      resolveDeploymentImages('local', {});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(`Could not resolve immutable digest for ${platformImageTag('web')}`);
    expect(message).toContain('403 Forbidden');
    expect(message).toContain(`images-v${PLATFORM_IMAGE_VERSION}`);
    expect(message).toContain(PLATFORM_IMAGES_WORKFLOW);
    expect(message).toContain('No project was written.');
  });

  it('does not blame the platform release for an operator override that fails', () => {
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'not found' });
    expect(() =>
      resolveDeploymentImages('aws', { AW_WEB_IMAGE: 'registry.example/web:mine' }),
    ).toThrow(/^Could not resolve immutable digest for registry\.example\/web:mine: not found\.$/u);
  });

  // spawnSync reports a missing binary as `error`, with no status and no output streams.
  it('says docker is missing, without blaming the release', () => {
    spawnSync.mockReturnValue({
      status: null,
      error: Object.assign(new Error('spawnSync docker ENOENT'), { code: 'ENOENT' }),
    });
    expect(() => resolveDeploymentImages('aws', {})).toThrow(
      new Error(
        `Could not resolve immutable digest for ${platformImageTag('web')}: ` +
          'docker is not installed or not on PATH.',
      ),
    );
  });
});

describe('the digest lookup retries a transient registry failure', () => {
  const noRoute =
    'ERROR: failed to copy: httpReadSeeker: failed open: failed to do request: Get "https://pkg-containers.githubusercontent.com/x": dial tcp 185.199.109.154:443: connect: no route to host';
  let waits: number[];

  beforeEach(() => {
    spawnSync.mockReset();
    waits = [];
    vi.spyOn(REGISTRY_RETRY, 'sleep').mockImplementation((ms: number) => {
      waits.push(ms);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const answers = (
    ...results: Array<{ status: number | null; stdout?: string; stderr?: string }>
  ) => {
    let call = 0;
    spawnSync.mockImplementation(() => {
      const next = results[Math.min(call, results.length - 1)];
      call += 1;
      return { stdout: '', stderr: '', ...next };
    });
  };
  const ok = { status: 0, stdout: JSON.stringify({ digest: digest('b') }) };

  it('resolves on the third try after two network failures, waiting 2 s then 4 s', () => {
    answers({ status: 1, stderr: noRoute }, { status: 1, stderr: 'i/o timeout' }, ok);
    const images = resolveDeploymentImages(
      'aws',
      { AW_WEB_IMAGE: 'registry.example/web:mine' },
      {
        gateway: `g@${digest('1')}`,
        runner: `r@${digest('2')}`,
        runtime: `t@${digest('3')}`,
      },
    );
    expect(images.web).toBe(`registry.example/web@${digest('b')}`);
    expect(spawnSync).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([2_000, 4_000]);
  });

  it('refuses a 403 or "not found" at once, with today\'s message', () => {
    answers({ status: 1, stderr: 'unexpected status: 403 Forbidden' });
    expect(() => resolveDeploymentImages('aws', {})).toThrow(/403 Forbidden\. The Agent/u);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    answers({ status: 1, stderr: 'not found' });
    expect(() =>
      resolveDeploymentImages('aws', { AW_WEB_IMAGE: 'registry.example/web:mine' }),
    ).toThrow(/^Could not resolve immutable digest for registry\.example\/web:mine: not found\.$/u);
    expect(waits).toEqual([]);
  });

  it("retries a silent failure (no stderr) and keeps today's fallback text when it persists", () => {
    answers({ status: 1, stderr: '' });
    expect(() =>
      resolveDeploymentImages('aws', { AW_WEB_IMAGE: 'registry.example/web:mine' }),
    ).toThrow(
      /^Could not resolve immutable digest for registry\.example\/web:mine: docker buildx failed \(after 4 attempts\)\.$/u,
    );
    expect(spawnSync).toHaveBeenCalledTimes(4);
  });

  it('does not retry docker that never finished', () => {
    answers({ status: null, stderr: 'timed out' });
    expect(() => resolveDeploymentImages('aws', {})).toThrow(/timed out\.$/u);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it('gives up after 4 attempts with the old message and the attempt count', () => {
    answers({ status: 1, stderr: noRoute });
    let message = '';
    try {
      resolveDeploymentImages('local', {});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(spawnSync).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([2_000, 4_000, 8_000]);
    expect(message).toContain(
      `Could not resolve immutable digest for ${platformImageTag('web')}: ${noRoute} (after 4 attempts).`,
    );
    expect(message).toContain('No project was written.');
  });

  it('tells a transient failure from a refusal', () => {
    for (const stderr of [
      noRoute,
      'net/http: TLS handshake timeout',
      'read: connection reset by peer',
      'unexpected status: 503 Service Unavailable',
      'unexpected status: 429 Too Many Requests',
      'dial tcp: lookup ghcr.io: no such host',
      '',
    ]) {
      expect(isTransientRegistryFailure(stderr), stderr).toBe(true);
    }
    for (const stderr of [
      'unexpected status: 403 Forbidden',
      'unexpected status: 401 Unauthorized',
      'ghcr.io/x:1: not found',
      'MANIFEST_UNKNOWN: manifest unknown',
      'docker is not installed or not on PATH',
      'docker buildx failed',
      'unexpected status from HEAD request: 403 Forbidden (proxy read timed out)',
    ]) {
      expect(isTransientRegistryFailure(stderr), stderr).toBe(false);
    }
  });
});

const FIELDS = ['web', 'gateway', 'runner', 'runtime', 'egressProxy', 'toolHost'] as const;
const pinnedDigests = Object.fromEntries(
  FIELDS.map((field, index) => [field, digest(String(index + 1))]),
);
const withDigests = (digests: unknown) => ({ ...document, digests });

describe('the platform image digests (D-14)', () => {
  it('accepts six valid digests and none at all', () => {
    expect(parseRelease(document).digests).toBeUndefined();
    expect(parseRelease(withDigests(pinnedDigests)).digests).toEqual(pinnedDigests);
  });

  it('refuses five digests, a bad digest and a placeholder of zeros', () => {
    const five = Object.fromEntries(
      Object.entries(pinnedDigests).filter(([name]) => name !== 'toolHost'),
    );
    expect(() => parseRelease(withDigests(five))).toThrow(/digests\.toolHost/u);
    expect(() => parseRelease(withDigests({ ...pinnedDigests, web: 'sha256:abc' }))).toThrow(
      /digests\.web/u,
    );
    expect(() => parseRelease(withDigests({ ...pinnedDigests, runner: digest('0') }))).toThrow(
      /digests\.runner/u,
    );
  });

  it('refuses a digest field no image has', () => {
    expect(() => parseRelease(withDigests({ ...pinnedDigests, extra: digest('9') }))).toThrow(
      /unexpected digest fields extra/u,
    );
  });

  it('is unpinned in a source checkout, so a reference is the tag', () => {
    expect(PLATFORM_IMAGES_PINNED).toBe(false);
    expect(platformImageReference('web')).toBe(platformImageTag('web'));
  });

  it('signs with images.yml on images-v tags', () => {
    expect(
      new RegExp(PLATFORM_IMAGE_SIGNER.identityRegexp, 'u').test(
        'https://github.com/indxjp/agent-workspace/.github/workflows/images.yml@refs/tags/images-v0.1.0',
      ),
    ).toBe(true);
    expect(PLATFORM_IMAGE_SIGNER.issuer).toBe('https://token.actions.githubusercontent.com');
  });
});

describe('a pinned release', () => {
  beforeEach(() => {
    spawnSync.mockReset();
    vi.resetModules();
    vi.doMock('./release-images.json', () => ({ default: withDigests(pinnedDigests) }));
  });
  afterEach(() => vi.doUnmock('./release-images.json'));

  it('references every image by digest', async () => {
    const pinned = await import('./release-images.ts');
    expect(pinned.PLATFORM_IMAGES_PINNED).toBe(true);
    expect(pinned.platformImageReference('web')).toBe(
      `${document.registry}/agent-workspace/${document.images.web}@${digest('1')}`,
    );
    expect(pinned.platformImageReference('toolHost')).toBe(
      `${document.registry}/agent-workspace/${document.images.toolHost}@${digest('6')}`,
    );
  });

  it('resolves the platform images without calling docker', async () => {
    const { resolveDeploymentImages, resolveToolHostImage } = await import('./deployment.ts');
    const images = resolveDeploymentImages('aws', {});
    expect(images.runner).toBe(
      `${document.registry}/agent-workspace/${document.images.runner}@${digest('3')}`,
    );
    expect(resolveToolHostImage({})).toContain(`@${digest('6')}`);
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
