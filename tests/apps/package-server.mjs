/**
 * The apps lane's loopback npm registry (issue #1531), for the one install the lane cannot point
 * at tarball paths: `npm ci` inside an app's own `Dockerfile`, which sees only the build context
 * and `package-lock.json`. It serves this checkout's packed `@indx-workspace/*` packages, at the
 * versions an app's `package.json` already pins, and sends every other request on to the public
 * registry with a redirect, so it holds nothing but the tarballs the lane packed.
 *
 * The lane locks an app copy against it (`npm install --package-lock-only --registry <url>`) and
 * builds the image with `--network host`, so the build's `npm ci` reaches the same loopback
 * address. A request for one of the packed packages at a version it was not packed at is a 404,
 * never a fall-through to the public registry: an image is built from this checkout or not at all.
 *
 * The lane runs its steps with `spawnSync`, which would stall a server on its own event loop, so
 * {@link spawnPackageServer} runs this file as a child process (`--serve <tarballs.json>`) that
 * prints its URL and serves until it is killed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

/** Where a request this registry does not hold goes. */
export const UPSTREAM_REGISTRY = 'https://registry.npmjs.org';

/**
 * The packument of one packed package: its manifest at its one version, with the `dist` npm
 * checks the tarball against.
 *
 * @param {Record<string, any>} manifest @param {Buffer} bytes @param {string} tarballUrl
 */
export function packumentOf(manifest, bytes, tarballUrl) {
  const { name, version } = manifest;
  return {
    name,
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        ...manifest,
        _id: `${String(name)}@${String(version)}`,
        dist: {
          tarball: tarballUrl,
          integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
          shasum: createHash('sha1').update(bytes).digest('hex'),
        },
      },
    },
  };
}

/**
 * What a request path asks for: the packument of a package, one of its tarballs, or neither.
 * npm asks for a scoped package as `/@scope%2fname`; a tarball is `/<name>/-/<file>.tgz`.
 *
 * @param {string} pathname
 * @returns {{ kind: 'packument', name: string } | { kind: 'tarball', name: string, file: string } | { kind: 'other' }}
 */
export function requestOf(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { kind: 'other' };
  }
  const tarball = /^\/((?:@[^/]+\/)?[^/@]+)\/-\/([^/]+\.tgz)$/u.exec(decoded);
  if (tarball !== null) return { kind: 'tarball', name: tarball[1] ?? '', file: tarball[2] ?? '' };
  const packument = /^\/((?:@[^/]+\/)?[^/@]+)$/u.exec(decoded);
  return packument === null ? { kind: 'other' } : { kind: 'packument', name: packument[1] ?? '' };
}

/** @param {string} tarball */
function manifestOf(tarball) {
  const read = spawnSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' });
  if (read.status !== 0) throw new Error(`could not read ${tarball}: ${read.stderr}`);
  return JSON.parse(read.stdout);
}

/**
 * Serve `tarballs` (package name → packed `.tgz`) on `127.0.0.1` until `close()`.
 *
 * @param {Readonly<Record<string, string>>} tarballs
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function startPackageServer(tarballs) {
  /** @type {Map<string, { file: string, packument: () => Record<string, any> }>} */
  const held = new Map();
  let base = '';
  for (const [name, tarball] of Object.entries(tarballs)) {
    const manifest = manifestOf(tarball);
    const file = path.basename(tarball);
    const bytes = readFileSync(tarball);
    held.set(name, {
      file: tarball,
      packument: () => packumentOf(manifest, bytes, `${base}/${name}/-/${file}`),
    });
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const asked = requestOf(url.pathname);
    const package_ = asked.kind === 'other' ? undefined : held.get(asked.name);
    if (package_ === undefined) {
      response.writeHead(302, { location: `${UPSTREAM_REGISTRY}${url.pathname}${url.search}` });
      response.end();
      return;
    }
    if (asked.kind === 'packument') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(package_.packument()));
      return;
    }
    if (asked.kind === 'tarball' && asked.file === path.basename(package_.file)) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      createReadStream(package_.file).pipe(response);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not packed by this checkout' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve(undefined);
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no loopback port');
  base = `http://127.0.0.1:${String(address.port)}`;
  return {
    url: base,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * {@link startPackageServer} in a child process, so a caller that blocks on `spawnSync` does not
 * stall it: its URL, and `close()`, which stops it.
 *
 * @param {Readonly<Record<string, string>>} tarballs @param {string} work a directory for the list
 * @returns {Promise<{ url: string, close: () => void }>}
 */
export async function spawnPackageServer(tarballs, work) {
  const list = path.join(work, 'package-server.json');
  writeFileSync(list, JSON.stringify(tarballs));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve', list], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const url = await new Promise((resolve, reject) => {
    let printed = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      printed += String(chunk);
      const line = /^(http:\/\/127\.0\.0\.1:\d+)$/mu.exec(printed);
      if (line !== null) resolve(line[1]);
    });
    child.once('exit', (code) => {
      reject(new Error(`the package server exited ${String(code)} before it listened`));
    });
  });
  return {
    url: String(url),
    close: () => {
      child.kill();
    },
  };
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.argv[2] === '--serve' &&
  process.argv[3] !== undefined
) {
  const served = await startPackageServer(JSON.parse(readFileSync(process.argv[3], 'utf8')));
  process.stdout.write(`${served.url}\n`);
}
