import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkDigests,
  checkPublishOrder,
  FIRST_PUBLISH_STEP,
  isPublished,
  npmRegistry,
  parseDigests,
  provenanceRefusal,
  provenanceSetting,
  publishAll,
  publishArguments,
  ReleaseRefusedError,
  releaseVersion,
  requireRegistered,
  SERVE_TIMEOUT_MS,
  tarballPaths,
  type Package,
} from '../../scripts/release/publish-packages.mjs';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

describe('the publish job trusts only the bytes verify recorded (regression, S1-12)', () => {
  it('reads sha256sum output and refuses a malformed or repeated line', () => {
    expect(
      parseDigests(
        `${DIGEST_A}  indx-workspace-sdk-0.1.0.tgz\n${DIGEST_B} *indx-workspace-aw-0.1.0.tgz\n`,
      ),
    ).toEqual(
      new Map([
        ['indx-workspace-sdk-0.1.0.tgz', DIGEST_A],
        ['indx-workspace-aw-0.1.0.tgz', DIGEST_B],
      ]),
    );
    expect(() => parseDigests(`${DIGEST_A.slice(1)}  a.tgz`)).toThrow(/malformed or repeated/u);
    expect(() => parseDigests(`${DIGEST_A}  a.tgz\n${DIGEST_B}  a.tgz`)).toThrow(
      /malformed or repeated/u,
    );
  });

  it('refuses a tarball changed after verify recorded it, an unrecorded one and a missing one', () => {
    const expected = new Map([
      ['a.tgz', DIGEST_A],
      ['b.tgz', DIGEST_B],
    ]);
    expect(checkDigests(new Map(expected), expected)).toEqual([]);
    expect(
      checkDigests(
        new Map([
          ['a.tgz', DIGEST_B],
          ['c.tgz', DIGEST_A],
        ]),
        expected,
      ),
    ).toEqual([
      `a.tgz is not the tarball the verify job packed (sha256 ${DIGEST_B})`,
      'c.tgz has no digest from the verify job',
      'b.tgz was packed but is not in the list',
    ]);
    expect(checkDigests(new Map([['a.tgz', DIGEST_A]]), new Map())).toEqual([
      'no digests from the verify job (EXPECTED_DIGESTS is empty)',
    ]);
  });

  it('takes the version from the packages-v tag and refuses any other ref', () => {
    expect(releaseVersion('packages-v0.2.1')).toBe('0.2.1');
    expect(releaseVersion('packages-v1.0.0-rc.1')).toBe('1.0.0-rc.1');
    expect(() => releaseVersion(undefined)).toThrow(/GITHUB_REF_NAME/u);
    expect(() => releaseVersion('v0.2.1')).toThrow(/GITHUB_REF_NAME/u);
    expect(() => releaseVersion('packages-v0.2')).toThrow(/GITHUB_REF_NAME/u);
  });
});

const PACKAGES: Package[] = [
  {
    tarball: '/t/indx-workspace-contracts-0.1.0.tgz',
    name: '@indx-workspace/contracts',
    version: '0.1.0',
  },
  {
    tarball: '/t/indx-workspace-platforms-0.1.0.tgz',
    name: '@indx-workspace/platforms',
    version: '0.1.0',
  },
  { tarball: '/t/indx-workspace-sdk-0.1.0.tgz', name: '@indx-workspace/sdk', version: '0.1.0' },
  { tarball: '/t/indx-workspace-react-0.1.0.tgz', name: '@indx-workspace/react', version: '0.1.0' },
  { tarball: '/t/indx-workspace-aw-0.1.0.tgz', name: '@indx-workspace/aw', version: '0.1.0' },
  { tarball: '/t/indx-workspace-cli-0.1.0.tgz', name: '@indx-workspace/cli', version: '0.1.0' },
  {
    tarball: '/t/indx-workspace-embedded-0.1.0.tgz',
    name: '@indx-workspace/embedded',
    version: '0.1.0',
  },
  {
    tarball: '/t/indx-workspace-create-0.1.0.tgz',
    name: '@indx-workspace/create',
    version: '0.1.0',
  },
];

/** A fake npm registry: `view` answers from `served`, `publish` adds to it unless it fails. */
function fakeNpm(
  initiallyServed: string[],
  options: { viewExit?: number; publishLands?: boolean } = {},
) {
  const served = new Set(initiallyServed);
  const calls: string[][] = [];
  const npm = (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === 'view' && args[2] === 'versions') {
      // Every package already has its Owner-published placeholder on npm.
      return { status: 0, stdout: '["0.0.0-bootstrap"]\n' };
    }
    if (args[0] === 'view') {
      const id = args[1] ?? '';
      const version = id.slice(id.lastIndexOf('@') + 1);
      // npm prints nothing and exits 0 when the package exists but the version does not.
      return served.has(id)
        ? { status: 0, stdout: `${version}\n` }
        : { status: options.viewExit ?? 0, stdout: '' };
    }
    const tarball = args[1] ?? '';
    const pkg = PACKAGES.find((candidate) => candidate.tarball === tarball);
    if (pkg !== undefined && options.publishLands !== false)
      served.add(`${pkg.name}@${pkg.version}`);
    return { status: 0, stdout: '' };
  };
  return { npm, calls };
}

const noWait = () => Promise.resolve();

/** An injected clock: `wait` advances it, so polling takes no real time. */
function fakeClock() {
  let time = 0;
  const waits: number[] = [];
  return {
    waits,
    now: () => time,
    wait: (ms: number) => {
      waits.push(ms);
      time += ms;
      return Promise.resolve();
    },
  };
}

describe('publishing the tarballs (issue #246, ADR-0082)', () => {
  it('treats only the exact version as published, never an empty view', () => {
    expect(isPublished('0.1.0\n', '0.1.0')).toBe(true);
    expect(isPublished('', '0.1.0')).toBe(false);
    expect(isPublished('0.1.1', '0.1.0')).toBe(false);
  });

  it('publishes every package when npm knows the names but not the version (view exits 0)', async () => {
    const { npm, calls } = fakeNpm([]);
    const result = await publishAll(PACKAGES, { provenance: false, npm, wait: noWait });
    expect(result.skipped).toEqual([]);
    expect(result.published).toEqual([
      '@indx-workspace/contracts@0.1.0',
      '@indx-workspace/platforms@0.1.0',
      '@indx-workspace/sdk@0.1.0',
      '@indx-workspace/react@0.1.0',
      '@indx-workspace/aw@0.1.0',
      '@indx-workspace/cli@0.1.0',
      '@indx-workspace/embedded@0.1.0',
      '@indx-workspace/create@0.1.0',
    ]);
    expect(calls.filter((args) => args[0] === 'publish').map((args) => args[1])).toEqual(
      PACKAGES.map(({ tarball }) => tarball),
    );
  });

  it('skips only a version npm serves, so a re-run finishes a partial release', async () => {
    const { npm } = fakeNpm(['@indx-workspace/contracts@0.1.0'], { viewExit: 1 });
    const result = await publishAll(PACKAGES, { provenance: false, npm, wait: noWait });
    expect(result.skipped).toEqual(['@indx-workspace/contracts@0.1.0']);
    expect(result.published).toHaveLength(7);
  });

  it('skips only the exact version: an older cli on npm does not skip this one', async () => {
    const { npm } = fakeNpm(['@indx-workspace/cli@0.0.9']);
    const result = await publishAll(PACKAGES, { provenance: false, npm, wait: noWait });
    expect(result.skipped).toEqual([]);
    expect(result.published).toContain('@indx-workspace/cli@0.1.0');
  });

  it('fails unless npm serves all eight, the last one included', async () => {
    const { npm } = fakeNpm([]);
    const lost = (args: readonly string[]) =>
      args[0] === 'view' && args[1] === '@indx-workspace/create@0.1.0'
        ? { status: 0, stdout: '' }
        : npm(args);
    await expect(
      publishAll(PACKAGES, { provenance: false, npm: lost, wait: noWait, timeoutMs: 0 }),
    ).rejects.toThrow(
      /npm does not serve @indx-workspace\/create@0\.1\.0 after .*served: .*contracts.*still pending: @indx-workspace\/create@0\.1\.0/u,
    );
  });

  it('keeps polling with backoff until npm serves a package that lags the publish', async () => {
    const { npm } = fakeNpm([]);
    const clock = fakeClock();
    let createViews = 0;
    const lagging = (args: readonly string[]) => {
      if (args[0] === 'view' && args[1] === '@indx-workspace/create@0.1.0') {
        createViews += 1;
        // The first view is the pre-publish skip check; served from the 6th view on.
        return createViews >= 6 ? { status: 0, stdout: '0.1.0' } : { status: 0, stdout: '' };
      }
      return npm(args);
    };
    const result = await publishAll(PACKAGES, { provenance: false, npm: lagging, ...clock });
    expect(result.published).toHaveLength(8);
    expect(clock.waits).toEqual([10_000, 20_000, 40_000, 60_000]);
  });

  it('names which packages are served and which are pending when npm never serves one', async () => {
    const { npm } = fakeNpm([]);
    const lost = (args: readonly string[]) =>
      args[0] === 'view' && /@indx-workspace\/(sdk|create)@/u.test(args[1] ?? '')
        ? { status: 0, stdout: '' }
        : npm(args);
    const clock = fakeClock();
    const failure = publishAll(PACKAGES, { provenance: false, npm: lost, ...clock });
    await expect(failure).rejects.toThrow(
      'npm does not serve @indx-workspace/sdk@0.1.0, @indx-workspace/create@0.1.0 after 15 min ' +
        '(served: @indx-workspace/contracts@0.1.0, @indx-workspace/platforms@0.1.0, ' +
        '@indx-workspace/react@0.1.0, ' +
        '@indx-workspace/aw@0.1.0, @indx-workspace/cli@0.1.0, ' +
        '@indx-workspace/embedded@0.1.0; ' +
        'still pending: @indx-workspace/sdk@0.1.0, @indx-workspace/create@0.1.0)',
    );
    expect(clock.waits.reduce((sum, ms) => sum + ms, 0)).toBe(SERVE_TIMEOUT_MS);
  });

  it('accepts only all eight packages, contracts first, embedded after cli and create last, at one version', () => {
    expect(checkPublishOrder(PACKAGES)).toEqual([]);
    const withoutEmbedded = PACKAGES.filter(({ name }) => name !== '@indx-workspace/embedded');
    expect(checkPublishOrder(withoutEmbedded)).toEqual([
      'the tarballs are @indx-workspace/contracts, @indx-workspace/platforms, @indx-workspace/sdk, ' +
        '@indx-workspace/react, @indx-workspace/aw, @indx-workspace/cli, @indx-workspace/create, not ' +
        '@indx-workspace/contracts, @indx-workspace/platforms, @indx-workspace/sdk, ' +
        '@indx-workspace/react, @indx-workspace/aw, ' +
        '@indx-workspace/cli, @indx-workspace/embedded, @indx-workspace/create',
    ]);
    expect(checkPublishOrder(PACKAGES.slice(0, 3))).toHaveLength(1);
    expect(checkPublishOrder([...PACKAGES].reverse())).toHaveLength(1);
    const skewed = PACKAGES.map((pkg) =>
      pkg.name === '@indx-workspace/cli' ? { ...pkg, version: '0.1.1' } : pkg,
    );
    expect(checkPublishOrder(skewed)).toEqual(['the tarballs are not lock-step: 0.1.0, 0.1.1']);
  });

  it('fails when a package is still not served after the loop', async () => {
    const { npm } = fakeNpm([], { publishLands: false });
    await expect(
      publishAll(PACKAGES, { provenance: false, npm, wait: noWait, timeoutMs: 0 }),
    ).rejects.toThrow(/npm does not serve @indx-workspace\/contracts@0\.1\.0/u);
  });

  it('fails when npm publish fails', async () => {
    const npm = (args: readonly string[]) =>
      args[0] === 'publish' ? { status: 1, stdout: '' } : { status: 0, stdout: '' };
    await expect(
      publishAll(PACKAGES, { provenance: false, npm, registry: () => 'known', wait: noWait }),
    ).rejects.toThrow(/npm publish @indx-workspace\/contracts@0\.1\.0 failed/u);
  });

  it('resolves each tarball list line against the list file, so basenames from an artifact work', () => {
    const list = path.resolve('artifact', 'packages', 'tarballs');
    expect(
      tarballPaths(
        list,
        `indx-workspace-contracts-0.1.0.tgz\r\n\n  indx-workspace-sdk-0.1.0.tgz  \n${path.resolve('elsewhere', 'a.tgz')}\n`,
      ),
    ).toEqual([
      path.resolve('artifact', 'packages', 'indx-workspace-contracts-0.1.0.tgz'),
      path.resolve('artifact', 'packages', 'indx-workspace-sdk-0.1.0.tgz'),
      path.resolve('elsewhere', 'a.tgz'),
    ]);
  });

  it('makes provenance one explicit switch, off by default', () => {
    expect(provenanceSetting(undefined)).toBe(false);
    expect(provenanceSetting('false')).toBe(false);
    expect(provenanceSetting('true')).toBe(true);
    expect(() => provenanceSetting('yes')).toThrow(/NPM_PROVENANCE/u);
    expect(publishArguments('a.tgz', false)).toEqual([
      'publish',
      'a.tgz',
      '--access',
      'public',
      '--provenance=false',
    ]);
    expect(publishArguments('a.tgz', true)).toContain('--provenance=true');
  });

  it('publishes nothing while npm has never served one package, naming the Owner first-publish step (regression, S1-12)', async () => {
    const { npm, calls } = fakeNpm([]);
    const registry = (name: string) =>
      name === '@indx-workspace/embedded' ? 'never-published' : 'known';
    const failure = publishAll(PACKAGES, { provenance: false, npm, registry, wait: noWait });
    await expect(failure).rejects.toBeInstanceOf(ReleaseRefusedError);
    await expect(failure).rejects.toMatchObject({
      code: 'NEVER_PUBLISHED',
      packages: ['@indx-workspace/embedded'],
    });
    await expect(failure).rejects.toThrow(FIRST_PUBLISH_STEP);
    expect(calls).toEqual([]);
  });

  it('publishes nothing when npm cannot say whether a package exists: a network error refuses (regression, S1-12)', async () => {
    const offline = (args: readonly string[]) =>
      args[0] === 'view' && args[2] === 'versions'
        ? { status: 1, stdout: '', stderr: 'npm error code ECONNRESET\nnpm error network aborted' }
        : { status: 0, stdout: '' };
    const calls: string[][] = [];
    const npm = (args: readonly string[]) => {
      calls.push([...args]);
      return offline(args);
    };
    const failure = publishAll(PACKAGES, { provenance: false, npm, wait: noWait });
    await expect(failure).rejects.toMatchObject({
      name: 'ReleaseRefusedError',
      code: 'REGISTRY_UNREACHABLE',
      packages: PACKAGES.map(({ name }) => name),
    });
    expect(calls.every((args) => args[0] === 'view' && args[2] === 'versions')).toBe(true);
    expect(calls.some((args) => args[0] === 'publish')).toBe(false);
  });

  it('proceeds when npm has served every package before', async () => {
    const { npm } = fakeNpm([]);
    const looked: string[] = [];
    const registry = (name: string) => {
      looked.push(name);
      return 'known' as const;
    };
    const result = await publishAll(PACKAGES, { provenance: false, npm, registry, wait: noWait });
    expect(looked).toEqual(PACKAGES.map(({ name }) => name));
    expect(result.published).toHaveLength(8);
  });

  it('reads npm view <name> versions --json: E404 or none is never published, an error is unreachable', () => {
    const answer = (status: number, stdout: string, stderr = '') => {
      const calls: string[][] = [];
      const state = npmRegistry((args) => {
        calls.push([...args]);
        return { status, stdout, stderr };
      })('@indx-workspace/embedded');
      expect(calls).toEqual([['view', '@indx-workspace/embedded', 'versions', '--json']]);
      return state;
    };
    expect(answer(0, '["0.0.0-bootstrap","0.2.1"]\n')).toBe('known');
    expect(answer(0, '"0.0.0-bootstrap"\n')).toBe('known');
    expect(answer(0, '[]')).toBe('never-published');
    expect(answer(1, '', 'npm error code E404\nnpm error 404 Not Found')).toBe('never-published');
    expect(answer(1, '{"error":{"code":"E404"}}')).toBe('never-published');
    expect(answer(1, '', 'npm error code ETIMEDOUT')).toBe('unreachable');
    expect(answer(1, '', 'npm error code E500')).toBe('unreachable');
    expect(answer(0, '')).toBe('unreachable');
    expect(answer(0, '{"unexpected":true}')).toBe('unreachable');
  });

  it('names a never-published package before an unreachable one', () => {
    const states = {
      '@indx-workspace/sdk': 'unreachable',
      '@indx-workspace/cli': 'never-published',
    };
    const registry = (name: string) =>
      (states as Record<string, 'unreachable' | 'never-published' | undefined>)[name] ?? 'known';
    expect(() => requireRegistered(PACKAGES, registry)).toThrow(
      /npm has never served @indx-workspace\/cli\..*Nothing was published/u,
    );
    expect(() => requireRegistered(PACKAGES, () => 'known')).not.toThrow();
  });

  it('refuses provenance before publishing unless the repository is public', () => {
    expect(provenanceRefusal(false, 'internal')).toBeUndefined();
    expect(provenanceRefusal(true, 'public')).toBeUndefined();
    expect(provenanceRefusal(true, 'internal')).toMatch(/public repository; this one is internal/u);
  });
});
