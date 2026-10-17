import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync,
}));

import { resolveDeploymentImages } from './deployment.ts';
import document from './release-images.json' with { type: 'json' };
import {
  PLATFORM_IMAGE_VERSION,
  PLATFORM_IMAGES_WORKFLOW,
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
