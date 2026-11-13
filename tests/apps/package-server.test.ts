/**
 * The apps lane's loopback registry (`package-server.mjs`, issue #1531): what an app image's
 * `npm ci` installs this checkout's packed packages from.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  packumentOf,
  requestOf,
  startPackageServer,
  UPSTREAM_REGISTRY,
} from './package-server.mjs';

describe('requestOf', () => {
  it('reads a scoped packument, a tarball and anything else', () => {
    expect(requestOf('/@indx-workspace%2fapp')).toEqual({
      kind: 'packument',
      name: '@indx-workspace/app',
    });
    expect(requestOf('/@indx-workspace/app/-/app-1.2.3.tgz')).toEqual({
      kind: 'tarball',
      name: '@indx-workspace/app',
      file: 'app-1.2.3.tgz',
    });
    expect(requestOf('/next')).toEqual({ kind: 'packument', name: 'next' });
    expect(requestOf('/-/v1/search')).toEqual({ kind: 'other' });
    expect(requestOf('/%E0%A4%A')).toEqual({ kind: 'other' });
  });
});

describe('packumentOf', () => {
  it('publishes the one packed version as latest, with the digests npm checks', () => {
    const bytes = Buffer.from('a tarball');
    const packument = packumentOf(
      { name: '@indx-workspace/app', version: '1.2.3' },
      bytes,
      'http://127.0.0.1:1/@indx-workspace/app/-/app.tgz',
    );

    expect(packument['dist-tags']).toEqual({ latest: '1.2.3' });
    expect(packument.versions['1.2.3']?.dist).toEqual({
      tarball: 'http://127.0.0.1:1/@indx-workspace/app/-/app.tgz',
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      shasum: createHash('sha1').update(bytes).digest('hex'),
    });
  });
});

describe('startPackageServer', () => {
  let work = '';
  let tarball = '';
  let server: Awaited<ReturnType<typeof startPackageServer>> | undefined;

  beforeAll(async () => {
    work = mkdtempSync(path.join(tmpdir(), 'package-server-'));
    mkdirSync(path.join(work, 'package'));
    writeFileSync(
      path.join(work, 'package', 'package.json'),
      JSON.stringify({ name: '@indx-workspace/app', version: '1.2.3' }),
    );
    tarball = path.join(work, 'indx-workspace-app-1.2.3.tgz');
    execFileSync('tar', ['-czf', tarball, '-C', work, 'package']);
    server = await startPackageServer({ '@indx-workspace/app': tarball });
  });

  afterAll(async () => {
    await server?.close();
    rmSync(work, { recursive: true, force: true });
  });

  it('serves the packed package and its tarball byte for byte', async () => {
    const url = server?.url ?? '';
    const packument = (await (await fetch(`${url}/@indx-workspace%2fapp`)).json()) as {
      versions: Record<string, { dist: { tarball: string } }>;
    };
    const href = packument.versions['1.2.3']?.dist.tarball ?? '';
    const bytes = Buffer.from(await (await fetch(href)).arrayBuffer());

    expect(href).toBe(`${url}/@indx-workspace/app/-/indx-workspace-app-1.2.3.tgz`);
    expect(bytes.equals(readFileSync(tarball))).toBe(true);
  });

  it('sends any other package to the public registry, and never another tarball of its own', async () => {
    const url = server?.url ?? '';
    const other = await fetch(`${url}/next?write=true`, { redirect: 'manual' });
    const stale = await fetch(`${url}/@indx-workspace/app/-/indx-workspace-app-1.0.0.tgz`, {
      redirect: 'manual',
    });

    expect(other.status).toBe(302);
    expect(other.headers.get('location')).toBe(`${UPSTREAM_REGISTRY}/next?write=true`);
    expect(stale.status).toBe(404);
  });
});
