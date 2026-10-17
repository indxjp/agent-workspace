/* global fetch */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { TestServicesError } from './errors.mjs';
import { SEAWEEDFS_VERSION, seaweedfsAssetFor } from './pins.mjs';
import {
  captureOutput,
  freePortsWithGrpc,
  hasExited,
  stopProcess,
  waitForS3Health,
} from './process.mjs';

/** @typedef {ReturnType<typeof import('./cleanup.mjs').createCleanup>} Cleanup */
/** @typedef {{ asset: string; sha256: string; url: string }} SeaweedfsPin */

const ATTEMPTS = 3;

/**
 * `${XDG_CACHE_HOME:-~/.cache}/agent-workspace/seaweedfs/<version>/`. A relative XDG_CACHE_HOME is
 * ignored, as the XDG base directory specification requires.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} home
 */
export function seaweedfsCacheDir(env, home) {
  const configured = env['XDG_CACHE_HOME'];
  const base =
    configured !== undefined && path.isAbsolute(configured)
      ? configured
      : path.join(home, '.cache');
  return path.join(base, 'agent-workspace', 'seaweedfs', SEAWEEDFS_VERSION);
}

/**
 * @param {string} file
 * @returns {Promise<string>}
 */
export async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * @param {string} subject
 * @param {SeaweedfsPin} pin
 * @param {string} actual
 * @param {string} remedy
 */
function checksumMismatch(subject, pin, actual, remedy) {
  return new TestServicesError(
    'seaweedfs_checksum_mismatch',
    `${subject} does not match the pinned SHA-256 of SeaweedFS ${SEAWEEDFS_VERSION} ${pin.asset} (${pin.url}): expected ${pin.sha256}, got ${actual}. It was not used. ${remedy}`,
  );
}

/**
 * The pinned release archive in the cache, downloaded on first use. A download is hashed while it
 * streams and moved into place only when it matches the pin; a mismatch deletes it and fails. The
 * cached archive is checked again on every use by `startNativeSeaweedfs`, never trusted.
 *
 * @param {{ cacheDir: string; pin: SeaweedfsPin; cleanup: Cleanup; fetchImpl?: typeof fetch }} input
 * @returns {Promise<string>}
 */
export async function ensureSeaweedfsArchive({ cacheDir, pin, cleanup, fetchImpl = fetch }) {
  const archive = path.join(cacheDir, pin.asset);
  if (existsSync(archive)) return archive;
  mkdirSync(cacheDir, { recursive: true });
  const partial = `${archive}.${randomUUID().slice(0, 8)}.partial`;
  cleanup.add(`remove ${partial}`, () => rmSync(partial, { force: true }));
  try {
    /** @type {Response} */
    let response;
    try {
      response = await fetchImpl(pin.url);
    } catch (error) {
      throw new TestServicesError(
        'seaweedfs_download_failed',
        `Downloading ${pin.url} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok || response.body === null) {
      throw new TestServicesError(
        'seaweedfs_download_failed',
        `Downloading ${pin.url} answered ${String(response.status)}.`,
      );
    }
    const hash = createHash('sha256');
    const hashing = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), hashing, createWriteStream(partial));
    const actual = hash.digest('hex');
    if (actual !== pin.sha256) {
      throw checksumMismatch(`The download of ${pin.url}`, pin, actual, 'Nothing was cached.');
    }
    renameSync(partial, archive);
    return archive;
  } finally {
    rmSync(partial, { force: true });
  }
}

/**
 * Copy the cached archive into the run's own directory, verify the copy against the pin, and
 * extract `weed` from it. Each run gets its own binary, so concurrent runs share nothing mutable.
 *
 * @param {string} archive
 * @param {SeaweedfsPin} pin
 * @param {string} root
 * @returns {Promise<string>}
 */
export async function extractVerifiedWeed(archive, pin, root) {
  const copy = path.join(root, pin.asset);
  copyFileSync(archive, copy);
  const actual = await sha256File(copy);
  if (actual !== pin.sha256) {
    throw checksumMismatch(
      `The cached ${archive}`,
      pin,
      actual,
      'Delete it and run again to download it afresh.',
    );
  }
  const extracted = spawnSync('tar', ['-xzf', copy, '-C', root, 'weed'], { encoding: 'utf8' });
  rmSync(copy, { force: true });
  if (extracted.status !== 0) {
    throw new TestServicesError(
      'seaweedfs_extract_failed',
      `Extracting weed from ${archive} failed: ${(extracted.stderr || extracted.error?.message || '').trim()}`,
    );
  }
  return path.join(root, 'weed');
}

/**
 * SeaweedFS `weed mini` from the pinned release binary, on free loopback ports, with the same S3
 * identity and readiness probe as the Docker path (ADR-0066).
 *
 * @param {Cleanup} cleanup
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{ endpoint: string }>}
 */
export async function startNativeSeaweedfs(cleanup, env) {
  const pin = seaweedfsAssetFor(process.platform, process.arch);
  const archive = await ensureSeaweedfsArchive({
    cacheDir: seaweedfsCacheDir(env, os.homedir()),
    pin,
    cleanup,
  });
  /** @type {string | undefined} */
  let root;
  cleanup.add('remove the native SeaweedFS directory', () => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });
  root = mkdtempSync(path.join(os.tmpdir(), 'aw-test-s3-'));
  const weed = await extractVerifiedWeed(archive, pin, root);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await startWeed(cleanup, weed, path.join(root, `data-${String(attempt)}`));
    } catch (error) {
      if (
        attempt < ATTEMPTS &&
        error instanceof TestServicesError &&
        error.code === 'seaweedfs_native_failed'
      ) {
        continue;
      }
      throw error;
    }
  }
}

/**
 * @param {Cleanup} cleanup
 * @param {string} weed
 * @param {string} dataDir
 * @returns {Promise<{ endpoint: string }>}
 */
async function startWeed(cleanup, weed, dataDir) {
  mkdirSync(dataDir);
  const [master, volume, filer, s3, admin] = await freePortsWithGrpc(5);
  if (
    master === undefined ||
    volume === undefined ||
    filer === undefined ||
    s3 === undefined ||
    admin === undefined
  ) {
    throw new Error('freePortsWithGrpc returned fewer than the 5 ports asked for');
  }
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  const stop = async () => {
    await stopProcess(child);
    // weed puts these two gRPC sockets in /tmp whatever TMPDIR says, and leaves them behind.
    for (const socket of [
      `admin-grpc-${String(admin + 10_000)}`,
      `s3-grpc-${String(s3 + 10_000)}`,
    ]) {
      rmSync(`/tmp/seaweedfs-${socket}.sock`, { force: true });
    }
  };
  cleanup.add(`stop SeaweedFS on port ${String(s3)}`, stop);
  child = spawn(
    weed,
    [
      'mini',
      `-dir=${dataDir}`,
      '-ip=127.0.0.1',
      '-ip.bind=127.0.0.1',
      `-master.port=${String(master)}`,
      `-volume.port=${String(volume)}`,
      `-filer.port=${String(filer)}`,
      `-s3.port=${String(s3)}`,
      `-admin.port=${String(admin)}`,
      '-s3.port.iceberg=0',
      '-s3.port.lance=0',
      '-webdav=false',
      '-admin.ui=false',
      '-master.telemetry=false',
      `-filer.localSocket=${path.join(dataDir, 'filer.sock')}`,
      `-s3.localSocket=${path.join(dataDir, 's3.sock')}`,
    ],
    {
      cwd: dataDir,
      // TMPDIR keeps weed's own log files inside the run directory.
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: 'agent_workspace',
        AWS_SECRET_ACCESS_KEY: 'agent_workspace',
        TMPDIR: dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  /** @type {Error | undefined} */
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
  });
  const output = captureOutput(child);
  const endpoint = `http://127.0.0.1:${String(s3)}`;
  try {
    await waitForS3Health(endpoint, () => {
      if (spawnError !== undefined || (child !== undefined && hasExited(child))) {
        throw new TestServicesError(
          'seaweedfs_native_failed',
          `SeaweedFS exited before it was ready (code ${String(child?.exitCode)}${spawnError ? `, ${spawnError.message}` : ''}).\n${output()}`,
        );
      }
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return { endpoint };
}
