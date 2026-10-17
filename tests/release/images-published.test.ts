/**
 * PR #403 review: `publish-packages.yml` refuses to publish packages whose pinned platform images
 * an anonymous client cannot pull yet.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkPinnedImagesPublished,
  pinnedImageReferences,
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

/** A registry that serves every manifest: a check against it fails only on the document. */
const servesEverything: typeof fetch = (input) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  return Promise.resolve(
    url.pathname === '/token'
      ? Response.json({ token: 'anonymous' })
      : new Response(null, { status: 200 }),
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
    await expect(checkPinnedImagesPublished(root, servesEverything)).rejects.toThrow(
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
    return Promise.resolve(new Response(null, { status: found ? 200 : 404 }));
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

  it('passes when every pinned image resolves anonymously', async () => {
    const references = await pinnedImageReferences(ROOT);
    const published = new Set(
      references.map((reference) => reference.slice(reference.indexOf('/') + 1)),
    );
    await expect(checkPinnedImagesPublished(ROOT, registry(published))).resolves.toEqual(
      references,
    );
  });

  it('fails naming each image that is not served', async () => {
    const references = await pinnedImageReferences(ROOT);
    const [first, ...rest] = references;
    const published = new Set(rest.map((reference) => reference.slice(reference.indexOf('/') + 1)));
    await expect(checkPinnedImagesPublished(ROOT, registry(published))).rejects.toThrow(
      new RegExp(
        `PINNED_IMAGES_NOT_PUBLISHED[\\s\\S]*${String(first).replaceAll('.', '\\.')}`,
        'u',
      ),
    );
  });

  it('runs in publish-packages.yml before anything is published', () => {
    const workflow = readFileSync(
      path.join(ROOT, '.github/workflows/publish-packages.yml'),
      'utf8',
    );
    const check = workflow.indexOf('node scripts/release/images-published.mjs');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(workflow.indexOf('node scripts/release/publish-packages.mjs'));
  });
});
