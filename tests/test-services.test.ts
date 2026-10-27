/**
 * `pnpm test`'s service selection and the native fallback's pins (#429, ADR-0066's amendment).
 *
 * `scripts/test-with-services.mjs` provides PostgreSQL and S3 from the caller's own servers, from
 * Docker, or natively on a host without Docker (the self-hosted `dgx` pool). These tests hold the
 * selection order, the SeaweedFS binary pin and its fail-closed checksum, and the cleanup registry
 * that runs on every exit path. They need neither Docker nor the network.
 */
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCleanup } from '../scripts/test-services/cleanup.mjs';
import { TestServicesError } from '../scripts/test-services/errors.mjs';
import {
  AZURITE_IMAGE,
  FAKE_GCS_SERVER_IMAGE,
  SEAWEEDFS_IMAGE,
  SEAWEEDFS_RELEASE_ASSETS,
  SEAWEEDFS_VERSION,
  seaweedfsAssetFor,
} from '../scripts/test-services/pins.mjs';
import {
  ensureSeaweedfsArchive,
  extractVerifiedWeed,
  seaweedfsCacheDir,
  sha256File,
} from '../scripts/test-services/seaweedfs.mjs';
import { selectServices } from '../scripts/test-services/select.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

const temporary: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aw-test-services-unit-'));
  temporary.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof TestServicesError) return error.code;
    throw error;
  }
  return undefined;
}

async function rejectionCodeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TestServicesError) return error.code;
    throw error;
  }
  return undefined;
}

describe('selectServices', () => {
  const external = { TEST_DATABASE_URL: 'postgres://db', TEST_S3_ENDPOINT: 'http://s3' };

  it.each([
    [{}, true, { postgres: 'docker', s3: 'docker' }],
    [{}, false, { postgres: 'native', s3: 'native' }],
    [{ AW_TEST_SERVICES: 'native' }, true, { postgres: 'native', s3: 'native' }],
    [{ AW_TEST_SERVICES: 'docker' }, true, { postgres: 'docker', s3: 'docker' }],
    [{ AW_TEST_SERVICES: '' }, false, { postgres: 'native', s3: 'native' }],
    [{ TEST_DATABASE_URL: 'postgres://db' }, false, { postgres: 'external', s3: 'native' }],
    [{ TEST_S3_ENDPOINT: 'http://s3' }, true, { postgres: 'docker', s3: 'external' }],
    [
      { TEST_DATABASE_URL: 'postgres://db', AW_TEST_SERVICES: 'native' },
      true,
      { postgres: 'external', s3: 'native' },
    ],
  ] as const)('selects %j with Docker %s as %j', (env, docker, expected) => {
    expect(selectServices({ env, dockerAvailable: () => docker })).toEqual(expected);
  });

  it('prefers the caller’s servers to every mode, and then never probes Docker', () => {
    const probe = vi.fn(() => true);
    for (const mode of [undefined, 'docker', 'native']) {
      expect(
        selectServices({ env: { ...external, AW_TEST_SERVICES: mode }, dockerAvailable: probe }),
      ).toEqual({ postgres: 'external', s3: 'external' });
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not probe Docker when native is forced, and probes at most once otherwise', () => {
    const probe = vi.fn(() => false);
    selectServices({ env: { AW_TEST_SERVICES: 'native' }, dockerAvailable: probe });
    expect(probe).not.toHaveBeenCalled();
    selectServices({ env: {}, dockerAvailable: probe });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown AW_TEST_SERVICES instead of guessing', () => {
    for (const mode of ['bogus', 'Docker', 'external']) {
      expect(
        codeOf(() =>
          selectServices({ env: { AW_TEST_SERVICES: mode }, dockerAvailable: () => true }),
        ),
      ).toBe('test_services_mode_invalid');
    }
  });

  it('fails a forced Docker mode without a daemon instead of falling back to native', () => {
    expect(
      codeOf(() =>
        selectServices({ env: { AW_TEST_SERVICES: 'docker' }, dockerAvailable: () => false }),
      ),
    ).toBe('docker_unavailable');
  });
});

describe('the SeaweedFS pins', () => {
  it('pins one archive with a SHA-256 for each supported host, the dgx pool’s linux-arm64 included', () => {
    expect(Object.keys(SEAWEEDFS_RELEASE_ASSETS).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
    ]);
    for (const pin of Object.values(SEAWEEDFS_RELEASE_ASSETS)) {
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(pin.asset).toMatch(/^(linux|darwin)_(amd64|arm64)\.tar\.gz$/u);
    }
    expect(seaweedfsAssetFor('linux', 'arm64')).toEqual({
      asset: 'linux_arm64.tar.gz',
      sha256: SEAWEEDFS_RELEASE_ASSETS['linux-arm64']?.sha256,
      url: `https://github.com/seaweedfs/seaweedfs/releases/download/${SEAWEEDFS_VERSION}/linux_arm64.tar.gz`,
    });
  });

  it('refuses a host without a pinned binary', () => {
    expect(codeOf(() => seaweedfsAssetFor('win32', 'x64'))).toBe('seaweedfs_platform_unsupported');
    expect(codeOf(() => seaweedfsAssetFor('linux', 'ppc64'))).toBe(
      'seaweedfs_platform_unsupported',
    );
    expect(codeOf(() => seaweedfsAssetFor('linux', 'constructor'))).toBe(
      'seaweedfs_platform_unsupported',
    );
  });

  it('pins the same image digest as the CI S3 step, so the two cannot drift apart', () => {
    const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const digests = [...ci.matchAll(/chrislusf\/seaweedfs@sha256:[0-9a-f]{64}/gu)].map((m) => m[0]);
    expect(digests.length).toBeGreaterThan(0);
    for (const digest of digests) expect(digest).toBe(SEAWEEDFS_IMAGE);
  });

  it('pins the same Azurite and fake-gcs-server digests as the CI emulator step', () => {
    const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    for (const [image, pin] of [
      ['mcr.microsoft.com/azure-storage/azurite', AZURITE_IMAGE],
      ['fsouza/fake-gcs-server', FAKE_GCS_SERVER_IMAGE],
    ] as const) {
      const pattern = new RegExp(
        `${image.replaceAll('.', String.raw`\.`)}@sha256:[0-9a-f]{64}`,
        'gu',
      );
      const digests = [...ci.matchAll(pattern)].map((m) => m[0]);
      expect(digests.length).toBeGreaterThan(0);
      for (const digest of digests) expect(digest).toBe(pin);
    }
  });

  it('caches under ${XDG_CACHE_HOME:-~/.cache}/agent-workspace/seaweedfs/<version>', () => {
    expect(seaweedfsCacheDir({ XDG_CACHE_HOME: '/xdg' }, '/home/u')).toBe(
      path.join('/xdg', 'agent-workspace', 'seaweedfs', SEAWEEDFS_VERSION),
    );
    for (const env of [{}, { XDG_CACHE_HOME: '' }, { XDG_CACHE_HOME: 'relative' }]) {
      expect(seaweedfsCacheDir(env, '/home/u')).toBe(
        path.join('/home/u', '.cache', 'agent-workspace', 'seaweedfs', SEAWEEDFS_VERSION),
      );
    }
  });
});

describe('the SeaweedFS download fails closed', () => {
  const archiveBytes = Buffer.from('not really an archive');
  const pinFor = (sha256: string) => ({
    asset: 'linux_arm64.tar.gz',
    sha256,
    url: 'https://example.invalid/linux_arm64.tar.gz',
  });

  it('deletes a download that does not match the pin and caches nothing', async () => {
    const cacheDir = path.join(tempDir(), 'cache');
    const cleanup = createCleanup();
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(archiveBytes)));
    const error = await ensureSeaweedfsArchive({
      cacheDir,
      pin: pinFor('0'.repeat(64)),
      cleanup,
      fetchImpl,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TestServicesError);
    expect((error as TestServicesError).code).toBe('seaweedfs_checksum_mismatch');
    expect((error as Error).message).toContain(`expected ${'0'.repeat(64)}`);
    expect(readdirSync(cacheDir)).toEqual([]);
    expect(await cleanup.run()).toEqual([]);
  });

  it('caches a matching download atomically and reuses it without downloading again', async () => {
    const source = path.join(tempDir(), 'source');
    writeFileSync(source, archiveBytes);
    const pin = pinFor(await sha256File(source));
    const cacheDir = path.join(tempDir(), 'cache');
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(archiveBytes)));
    const first = await ensureSeaweedfsArchive({
      cacheDir,
      pin,
      cleanup: createCleanup(),
      fetchImpl,
    });
    expect(readdirSync(cacheDir)).toEqual(['linux_arm64.tar.gz']);
    expect(await sha256File(first)).toBe(pin.sha256);
    await ensureSeaweedfsArchive({ cacheDir, pin, cleanup: createCleanup(), fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a failed download as a typed error', async () => {
    const cacheDir = path.join(tempDir(), 'cache');
    const pin = pinFor('0'.repeat(64));
    const unreachable = () => Promise.reject(new Error('getaddrinfo ENOTFOUND'));
    const notFound = () => Promise.resolve(new Response('missing', { status: 404 }));
    for (const fetchImpl of [unreachable, notFound]) {
      expect(
        await rejectionCodeOf(
          ensureSeaweedfsArchive({ cacheDir, pin, cleanup: createCleanup(), fetchImpl }),
        ),
      ).toBe('seaweedfs_download_failed');
    }
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  it('verifies the cached archive on every use and refuses a tampered one before extracting', async () => {
    const fixture = tempDir();
    writeFileSync(path.join(fixture, 'weed'), '#!/bin/sh\n', { mode: 0o755 });
    const archive = path.join(tempDir(), 'linux_arm64.tar.gz');
    expect(spawnSync('tar', ['-czf', archive, '-C', fixture, 'weed']).status).toBe(0);
    const pin = pinFor(await sha256File(archive));

    const good = tempDir();
    const weed = await extractVerifiedWeed(archive, pin, good);
    expect(weed).toBe(path.join(good, 'weed'));
    expect(readdirSync(good)).toEqual(['weed']);

    writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from('x')]));
    const tampered = tempDir();
    expect(await rejectionCodeOf(extractVerifiedWeed(archive, pin, tampered))).toBe(
      'seaweedfs_checksum_mismatch',
    );
    expect(existsSync(path.join(tampered, 'weed'))).toBe(false);
  });
});

describe('the cleanup registry', () => {
  it('runs steps last-in first-out, once, past a failing step, and reports the failure', async () => {
    const order: string[] = [];
    const cleanup = createCleanup();
    cleanup.add('first', () => order.push('first'));
    cleanup.add('failing', () => {
      order.push('failing');
      throw new Error('stuck');
    });
    cleanup.add('last', () => Promise.resolve(order.push('last')));

    const [first, second] = await Promise.all([cleanup.run(), cleanup.run()]);
    expect(order).toEqual(['last', 'failing', 'first']);
    expect(first).toBe(second);
    expect(first.map((failure) => failure.label)).toEqual(['failing']);
    await cleanup.run();
    expect(order).toHaveLength(3);
  });

  it('refuses a new step once cleanup has started, so nothing starts after it', async () => {
    const cleanup = createCleanup();
    await cleanup.run();
    expect(codeOf(() => cleanup.add('late', () => undefined))).toBe('test_services_interrupted');
  });
});

/** @param manifest a `package.json` path relative to the repository root */
function dependencyPins(manifest: string) {
  return JSON.parse(readFileSync(path.join(ROOT, manifest), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}

describe('the native fallback reuses existing pins', () => {
  // The root declares both for the helpers' imports. It must declare the very version the owning
  // package pins, so the lockfile holds one copy and the native path runs what production runs.
  it.each([
    ['packages/embedded', 'embedded-postgres'],
    ['packages/core', 'pg'],
  ])('declares the %s pin of %s at the root', (owner, name) => {
    const pin = dependencyPins(path.join(owner, 'package.json')).dependencies?.[name];
    expect(pin).toEqual(expect.any(String));
    expect(dependencyPins('package.json').devDependencies?.[name]).toBe(pin);
  });
});

describe('the native PostgreSQL cluster', () => {
  // initdb copies the host's TZ into the cluster's `timezone`, so on a JST host every text-cast
  // timestamptz read `+09` and year-0001 values carried a local-mean-time offset Date cannot parse.
  // `DROP DATABASE` waits for a forced checkpoint; with fsync on, dozens of suites tearing down at
  // once queued on those checkpoints and `isolated.close()` took up to 9 s of the 10 s hook budget.
  it('runs in UTC and without fsync, whatever the host time zone is', async () => {
    const dir = tempDir();
    const port = await freeLoopbackPort();
    const child = spawn(
      process.execPath,
      [
        path.join(ROOT, 'scripts/test-services/postgres-native-child.mjs'),
        path.join(dir, 'data'),
        String(port),
      ],
      { env: { ...process.env, TZ: 'Asia/Tokyo', TMPDIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const exited = once(child, 'exit');
    try {
      await new Promise<void>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          if (stdout.includes('{"ready":true}')) resolve();
        });
        // Drained so a full pipe cannot block the helper's synchronous log writes.
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.once('exit', (code) => {
          reject(
            new Error(
              `native PostgreSQL exited before it was ready (code ${String(code)})\n${stderr}`,
            ),
          );
        });
      });
      // `pg` ships no types at the root, so the query runs in a plain module.
      const query = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          [
            "import pg from 'pg';",
            `const client = new pg.Client('postgres://postgres:postgres@127.0.0.1:${String(port)}/agent_workspace_test');`,
            'await client.connect();',
            "const { rows } = await client.query(\"select current_setting('timezone') as tz, current_setting('fsync') as fsync, current_setting('full_page_writes') as fpw\");",
            'await client.end();',
            'process.stdout.write(JSON.stringify(rows[0]));',
          ].join('\n'),
        ],
        { cwd: ROOT, encoding: 'utf8' },
      );
      expect(query.stderr).toBe('');
      expect(JSON.parse(query.stdout)).toEqual({ tz: 'UTC', fsync: 'off', fpw: 'off' });
    } finally {
      child.stdin.end();
      await exited;
    }
  }, 120_000);
});

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port);
        else reject(new Error('no loopback port was assigned'));
      });
    });
  });
}
