/**
 * ENG-07 (#306, docs/adr/0073-one-runtime-image-per-engine.md): the engines a runtime image is
 * built for, held against every other place that names them.
 *
 * `scripts/engine-images.mjs` derives the list from the tree (`packages/engine-<id>`). This suite
 * holds that derivation to the published catalogue (`ENGINE_IDS`), to `runtime.Dockerfile`'s defaults and labels, and to the release's image list, so none of them
 * can drift without a failing test naming it.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ENGINE_IDS } from '@indx-workspace/contracts/engines';

import { engineImages } from '../scripts/engine-images.mjs';
import { releaseImages } from '../scripts/release/check.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (file: string) => readFile(path.join(ROOT, file), 'utf8');

function dockerArg(dockerfile: string, name: string): string | undefined {
  return new RegExp(`^ARG ${name}=(\\S+)$`, 'mu').exec(dockerfile)?.[1];
}

describe('runtime images per engine', () => {
  const images = engineImages();

  it('builds one image for every engine with an adapter, and only for published engines', () => {
    const ids = images.map((image) => image.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(ENGINE_IDS).toContain(id);
    for (const image of images) expect(image.image).toBe(`runtime-${image.id}`);
  });

  it("defaults runtime.Dockerfile to the Claude engine's arguments, so the plain build is today's image", async () => {
    const dockerfile = await read('runtime.Dockerfile');
    const claude = images.find((image) => image.id === 'claude-agent-sdk');
    expect(claude?.engineSdk).toBe('@anthropic-ai/claude-agent-sdk');
    expect(dockerArg(dockerfile, 'ENGINE')).toBe('claude-agent-sdk');
    expect(dockerArg(dockerfile, 'ENGINE_VERSION')).toBe(claude?.engineVersion);
    expect(dockerfile).toContain('io.agent-workspace.engine="${ENGINE}"');
    expect(dockerfile).toContain('io.agent-workspace.engine-version="${ENGINE_VERSION}"');
    expect(dockerfile).toContain('COPY packages/engine-${ENGINE} packages/engine-${ENGINE}');
    expect(dockerfile).not.toContain('packages/engine-claude-agent-sdk');
  });

  it('pins every Node base image by digest', async () => {
    for (const file of ['Dockerfile', 'gateway.Dockerfile', 'runtime.Dockerfile']) {
      expect(dockerArg(await read(file), 'NODE_IMAGE'), file).toMatch(
        /^node:24\.22\.1-bookworm-slim@sha256:[0-9a-f]{64}$/u,
      );
    }
  });

  it('lists every runtime image among the images a release publishes', () => {
    expect(releaseImages(ROOT)).toEqual([
      'web',
      'gateway',
      'runner',
      'egress-proxy',
      'tool-host',
      ...images.map((image) => image.image),
    ]);
  });
});
