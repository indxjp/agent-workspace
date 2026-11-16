/**
 * PR #403 review: `publish-packages.yml` refuses to publish packages whose pinned platform images
 * an anonymous client cannot pull yet.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  pinImageDigests,
  pinnedImageReferences,
  referenceResolvesAnonymously,
} from '../../scripts/release/images-published.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A repository root whose `release-images.json` is `document`. */
function rootWith(document: unknown): string {
  const root = mkdtempSync(path.join(tmpdir(), 'images-published-'));
  roots.push(root);
  const directory = path.join(root, 'packages', 'cli', 'src');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'release-images.json'), JSON.stringify(document));
  return root;
}

const DIGEST = `sha256:${'a'.repeat(64)}`;

/** A registry that serves every manifest: a check against it fails only on the document. */
const servesEverything: typeof fetch = (input) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  return Promise.resolve(
    url.pathname === '/token'
      ? Response.json({ token: 'anonymous' })
      : new Response(null, { status: 200, headers: { 'docker-content-digest': DIGEST } }),
  );
};

describe('the pinned-image check never passes having checked nothing', () => {
  const base = { registry: 'ghcr.io/example', version: '1.2.3' };

  it.each([
    ['an empty object', {}],
    ['null', null],
    ['an array', ['web']],
    ['a string', 'web'],
    ['a number', 1],
  ])('refuses images that is %s', async (_shape, images) => {
    const root = rootWith({ ...base, images });
    await expect(pinnedImageReferences(root)).rejects.toThrow(/^RELEASE_IMAGES_INVALID: /u);
    await expect(pinImageDigests(root, servesEverything)).rejects.toThrow(
      /^RELEASE_IMAGES_INVALID: /u,
    );
  });

  it('says an empty images pins nothing to check', async () => {
    await expect(pinnedImageReferences(rootWith({ ...base, images: {} }))).rejects.toThrow(
      /pins no image/u,
    );
  });

  it('refuses an image named by something not a non-empty string', async () => {
    for (const name of ['', 7, null]) {
      await expect(
        pinnedImageReferences(rootWith({ ...base, images: { web: 'web', gateway: name } })),
      ).rejects.toThrow(/^RELEASE_IMAGES_INVALID: /u);
    }
  });

  it('refuses a document that is not an object', async () => {
    await expect(pinnedImageReferences(rootWith(null))).rejects.toThrow(
      /^RELEASE_IMAGES_INVALID: /u,
    );
  });

  it('reads one well-formed image', async () => {
    await expect(
      pinnedImageReferences(rootWith({ ...base, images: { web: 'web' } })),
    ).resolves.toEqual(['ghcr.io/example/agent-workspace/web:1.2.3']);
  });
});

/** A registry that serves exactly the `repository:tag` pairs in `published`. */
function registry(published: ReadonlySet<string>): typeof fetch {
  return (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    if (url.pathname === '/token') {
      return Promise.resolve(Response.json({ token: 'anonymous' }));
    }
    const match = /^\/v2\/(.+)\/manifests\/([^/]+)$/u.exec(url.pathname);
    const authorised = new Headers(init?.headers).get('authorization') === 'Bearer anonymous';
    const found = match !== null && authorised && published.has(`${match[1]}:${match[2]}`);
    return Promise.resolve(
      new Response(null, {
        status: found ? 200 : 404,
        headers: found ? { 'docker-content-digest': DIGEST } : {},
      }),
    );
  };
}

describe('the pinned images are published before the packages', () => {
  it('names every image release-images.json pins, at its version', async () => {
    const document = JSON.parse(
      readFileSync(path.join(ROOT, 'packages/cli/src/release-images.json'), 'utf8'),
    ) as { registry: string; version: string; images: Record<string, string> };
    await expect(pinnedImageReferences(ROOT)).resolves.toEqual(
      Object.values(document.images).map(
        (name) => `${document.registry}/agent-workspace/${name}:${document.version}`,
      ),
    );
  });

  it('runs in publish-packages.yml before anything is published', () => {
    const workflow = readFileSync(
      path.join(ROOT, '.github/workflows/publish-packages.yml'),
      'utf8',
    );
    const check = workflow.indexOf('node scripts/release/images-published.mjs --pin');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(workflow.indexOf('node scripts/release/publish-packages.mjs'));
  });
});

describe('the digest of each image is pinned from the registry answer', () => {
  const reference = 'ghcr.io/example/agent-workspace/web:1.2.3';

  /** A registry whose manifest HEAD answers with `headers`. */
  function answering(headers: Record<string, string>): typeof fetch {
    return (input) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      );
      return Promise.resolve(
        url.pathname === '/token'
          ? Response.json({ token: 'anonymous' })
          : new Response(null, { status: 200, headers }),
      );
    };
  }

  it('returns the docker-content-digest header', async () => {
    await expect(
      referenceResolvesAnonymously(reference, answering({ 'docker-content-digest': DIGEST })),
    ).resolves.toEqual({ ok: true, digest: DIGEST });
  });

  it.each([
    ['missing', {}],
    ['not sha256', { 'docker-content-digest': `sha512:${'a'.repeat(64)}` }],
    ['too short', { 'docker-content-digest': `sha256:${'a'.repeat(63)}` }],
    ['upper case', { 'docker-content-digest': `sha256:${'A'.repeat(64)}` }],
  ])('refuses a %s digest', async (_case, headers) => {
    await expect(referenceResolvesAnonymously(reference, answering(headers))).resolves.toEqual({
      ok: false,
      reason: 'no content digest',
    });
  });

  const images = {
    web: 'web',
    gateway: 'gateway',
    runner: 'runner',
    runtime: 'runtime-claude-agent-sdk',
    egressProxy: 'egress-proxy',
    toolHost: 'tool-host',
  };
  const document = { registry: 'ghcr.io/example', version: '1.2.3', images };

  it('writes exactly six digests keyed like images, and returns digest references', async () => {
    const root = rootWith(document);
    const file = path.join(root, 'packages/cli/src/release-images.json');
    const pinned = await pinImageDigests(root, servesEverything);
    const written = readFileSync(file, 'utf8');
    expect(written.endsWith('}\n')).toBe(true);
    expect(JSON.parse(written)).toEqual({
      ...document,
      digests: Object.fromEntries(Object.keys(images).map((field) => [field, DIGEST])),
    });
    expect(pinned).toEqual(
      Object.values(images).map((name) => `ghcr.io/example/agent-workspace/${name}@${DIGEST}`),
    );
  });

  it('writes nothing and throws when one image is unpublished', async () => {
    const root = rootWith(document);
    const file = path.join(root, 'packages/cli/src/release-images.json');
    const before = readFileSync(file, 'utf8');
    const published = new Set(
      Object.values(images)
        .filter((name) => name !== 'tool-host')
        .map((name) => `example/agent-workspace/${name}:1.2.3`),
    );
    await expect(pinImageDigests(root, registry(published))).rejects.toThrow(
      /^PINNED_IMAGES_NOT_PUBLISHED[\s\S]*tool-host/u,
    );
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('publish-packages.yml pins and verifies before building', () => {
  const workflow = readFileSync(path.join(ROOT, '.github/workflows/publish-packages.yml'), 'utf8');

  it('pins, then verifies the signatures, then builds and packs', () => {
    const pin = workflow.indexOf('images-published.mjs --pin');
    const verify = workflow.indexOf('cosign verify "$reference"');
    expect(pin).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(pin);
    expect(workflow.indexOf('Build the published packages')).toBeGreaterThan(verify);
    expect(workflow.indexOf('pack-packages.mjs')).toBeGreaterThan(verify);
  });

  it('fails the pin step when the pin fails, and when the pins file or digests are incomplete', () => {
    const start = workflow.indexOf('name: Pin the platform image digests');
    const pinStep = workflow.slice(start, workflow.indexOf('sigstore/cosign-installer', start));
    expect(pinStep).toContain('set -euo pipefail');
    expect(pinStep).not.toContain('| tee');
    expect(pinStep).toContain('release-images.json');
    expect(pinStep).toContain('lines.length < fields.length');
  });
});
