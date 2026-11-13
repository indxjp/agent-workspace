import { afterEach, describe, expect, it, vi } from 'vitest';

import { ENV_IMAGE_KEYS } from '../render/env.js';
import { digest, stubRunner } from './deploy.test-support.js';
import { cloudRunImages, withCopiedImages } from './project-cloudrun-images.js';
import type { CloudRunModule, DeployProjectEnvironmentOptions } from './project-types.js';
import type { DeployContext } from './steps.js';

const registry = 'asia-northeast1-docker.pkg.dev/acme-prod/agent-workspace';
const own = (name: string, character: string) => `${registry}/${name}@${digest(character)}`;
const pins = {
  [ENV_IMAGE_KEYS.web]: own('web', '1'),
  [ENV_IMAGE_KEYS.gateway]: own('gateway', '2'),
  [ENV_IMAGE_KEYS.runner]: own('runner', '3'),
  [ENV_IMAGE_KEYS.runtime]: own('runtime', '4'),
  [ENV_IMAGE_KEYS.toolHost]: own('tool-host', '5'),
};

async function run(env: NodeJS.ProcessEnv, statePins: Record<string, string> = pins) {
  const out: string[] = [];
  const err: string[] = [];
  const context: DeployContext = {
    runner: stubRunner(() => ({ stdout: `${registry}\n` })).runner,
    directory: '/tmp',
    env,
    cloud: 'gcp',
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
  };
  await cloudRunImages({ env, apply: false } as DeployProjectEnvironmentOptions, {
    cloudRunModule: { moduleDirectory: '/module' } as CloudRunModule,
    pins: statePins,
    ownerEmail: 'owner@example.com',
    context,
    sandboxInternet: false,
    apps: {},
  });
  return { out: out.join(''), err: err.join('') };
}

describe('the AW_*_IMAGE override warning', () => {
  it('names a variable the user set, with the reference the deploy uses', async () => {
    const { err } = await run({
      AW_WEB_IMAGE: own('web', '1'),
      AW_GATEWAY_IMAGE: own('gateway', '2'),
      AW_RUNNER_IMAGE: own('runner', '3'),
      AW_RUNTIME_IMAGE: own('runtime', '4'),
      AW_TOOL_HOST_IMAGE: own('tool-host', '5'),
    });
    expect(err).toContain(
      `warning: AW_WEB_IMAGE overrides the pinned release image; this deploy uses ${own('web', '1')}, which this CLI release did not pin.\n`,
    );
    expect(err.match(/overrides the pinned release image/gu)).toHaveLength(5);
  });

  it('does not name the egress proxy override without sandboxInternet', async () => {
    const { err } = await run({
      AW_WEB_IMAGE: own('web', '1'),
      AW_GATEWAY_IMAGE: own('gateway', '2'),
      AW_RUNNER_IMAGE: own('runner', '3'),
      AW_RUNTIME_IMAGE: own('runtime', '4'),
      AW_EGRESS_PROXY_IMAGE: own('egress-proxy', '6'),
    });
    expect(err).not.toContain('AW_EGRESS_PROXY_IMAGE');
  });

  it('is silent about the references a deploy copied itself', async () => {
    const copied = withCopiedImages(
      {},
      {
        web: own('web', '1'),
        gateway: own('gateway', '2'),
        runner: own('runner', '3'),
        runtime: own('runtime', '4'),
        toolHost: own('tool-host', '5'),
      },
    );
    expect(copied['AW_WEB_IMAGE']).toBe(own('web', '1'));
    // The user's own environment is what `cloudRunImages` is given, so the copies never warn.
    const { err } = await run({}, pins);
    expect(err).not.toContain('overrides the pinned release image');
  });
});

describe('the release references cosign verifies', () => {
  const field = (name: string) => `ghcr.io/indxjp/agent-workspace/${name}`;
  const fields = ['web', 'gateway', 'runner', 'runtime', 'egressProxy', 'toolHost'] as const;
  const document = {
    registry: 'ghcr.io/indxjp',
    version: '0.1.0',
    images: {
      web: 'web',
      gateway: 'gateway',
      runner: 'runner',
      runtime: 'runtime',
      egressProxy: 'egress-proxy',
      toolHost: 'tool-host',
    },
    digests: Object.fromEntries(fields.map((name, index) => [name, digest(String(index + 1))])),
  };

  async function verified(
    env: NodeJS.ProcessEnv,
    recovery?: Readonly<Record<string, string>>,
  ): Promise<string[]> {
    vi.resetModules();
    vi.doMock('../release-images.json', () => ({ default: document }));
    const { cloudRunImages: pinnedImages } = await import('./project-cloudrun-images.js');
    const present = new Set<string>();
    const stub = stubRunner(({ tool, args }) => {
      if (tool === 'terraform') return { stdout: `${registry}\n` };
      if (tool !== 'docker') return {};
      if (args[2] === 'create') {
        const [tagged = '', source = ''] = args.slice(4);
        present.add(
          `${tagged.slice(0, tagged.lastIndexOf(':'))}${source.slice(source.indexOf('@'))}`,
        );
        return {};
      }
      const reference = args[3] ?? '';
      return present.has(reference)
        ? { stdout: JSON.stringify({ digest: reference.slice(reference.indexOf('@') + 1) }) }
        : { status: 1 };
    });
    await pinnedImages({ env, apply: true } as DeployProjectEnvironmentOptions, {
      cloudRunModule: { moduleDirectory: '/module' } as CloudRunModule,
      pins: recovery ?? null,
      ...(recovery === undefined ? {} : { registry }),
      ownerEmail: 'owner@example.com',
      context: {
        runner: stub.runner,
        directory: '/tmp',
        env,
        cloud: 'gcp',
        out: () => undefined,
        err: () => undefined,
      },
      sandboxInternet: false,
      apps: {},
    });
    return stub.calls
      .filter(({ tool, args }) => tool === 'cosign' && args[0] === 'verify')
      .map(({ args }) => args[1] ?? '');
  }

  afterEach(() => vi.doUnmock('../release-images.json'));

  it('verifies the pinned references and not an override', async () => {
    const sources = await verified({ AW_RUNNER_IMAGE: own('runner', 'a') });
    expect(sources.sort()).toEqual(
      ['web', 'gateway', 'runtime', 'tool-host']
        .map((name, index) => `${field(name)}@${digest(String([1, 2, 4, 6][index]))}`)
        .sort(),
    );
  });

  it('verifies the release sources re-copied over a state pin missing from Artifact Registry', async () => {
    const sources = await verified({}, pins);
    expect(sources).toEqual(
      expect.arrayContaining(
        ['web', 'gateway', 'runtime', 'tool-host'].map(
          (name, index) => `${field(name)}@${digest(String([1, 2, 4, 6][index]))}`,
        ),
      ),
    );
  });
});

describe('an unpinned CLI redeploying with every pin in Artifact Registry', () => {
  it('never inspects a ghcr release tag', async () => {
    const stub = stubRunner(({ tool, args }) => {
      if (tool === 'terraform') return { stdout: `${registry}\n` };
      const reference = args[3] ?? '';
      return tool === 'docker' && reference.startsWith(registry)
        ? { stdout: JSON.stringify({ digest: reference.slice(reference.indexOf('@') + 1) }) }
        : { status: 1 };
    });
    const env = {};
    await cloudRunImages({ env, apply: true } as DeployProjectEnvironmentOptions, {
      cloudRunModule: { moduleDirectory: '/module' } as CloudRunModule,
      pins,
      registry,
      ownerEmail: 'owner@example.com',
      context: {
        runner: stub.runner,
        directory: '/tmp',
        env,
        cloud: 'gcp',
        out: () => undefined,
        err: () => undefined,
      },
      sandboxInternet: false,
      apps: {},
    });
    const ghcr = stub.calls.filter(({ args }) => args.some((arg) => arg.includes('ghcr.io')));
    expect(ghcr).toEqual([]);
  });
});
