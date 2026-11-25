/**
 * The store's screenshots (use-cases plan §6.3): every live entry has its result card in Japanese
 * and in English at `examples/store/public/shots/<slug>.<ja|en>.webp`, each a WebP image, and the
 * folder holds nothing else. `node tests/store/shots/shoot.mjs` writes them (its header says what
 * to build first); nobody edits them by hand.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CATALOG, COUNTS } from '../../examples/store/catalog/index.ts';
import {
  expectedShots,
  isWebp,
  renderShotSizes,
  SHOTS_DIR,
  SHOTS_GENERATED,
  webpSize,
} from './shots/shots.mjs';

const REGENERATE = 'node tests/store/shots/shoot.mjs';

describe('the store screenshots', () => {
  const shots = expectedShots(CATALOG);

  it('are two per live entry', () => {
    expect(shots).toHaveLength(COUNTS.live * 2);
  });

  it(`exist for every live entry in both languages (missing: run ${REGENERATE})`, () => {
    const missing = shots.filter(({ file }) => !existsSync(path.join(SHOTS_DIR, file)));
    expect(missing.map(({ file }) => file)).toStrictEqual([]);
  });

  it('are WebP images', () => {
    const notWebp = shots
      .filter(({ file }) => existsSync(path.join(SHOTS_DIR, file)))
      .filter(({ file }) => !isWebp(readFileSync(path.join(SHOTS_DIR, file))));
    expect(notWebp.map(({ file }) => file)).toStrictEqual([]);
  });

  it(`are the only files in the folder (a soon or renamed entry's: run ${REGENERATE})`, () => {
    const expected = new Set(shots.map(({ file }) => file));
    expect(readdirSync(SHOTS_DIR).filter((file) => !expected.has(file))).toStrictEqual([]);
  });

  it(`have their sizes in shots.generated.ts, for each <img> (stale: run ${REGENERATE})`, () => {
    const sizes = Object.fromEntries(
      shots
        .filter(({ file }) => existsSync(path.join(SHOTS_DIR, file)))
        .map(({ slug, lang, file }) => [
          `${slug}.${lang}`,
          webpSize(readFileSync(path.join(SHOTS_DIR, file))),
        ]),
    );
    expect(readFileSync(SHOTS_GENERATED, 'utf8')).toBe(renderShotSizes(sizes));
  });

  it('read the size of a lossy, a lossless and an extended WebP, and refuse anything else', () => {
    const riff = (chunk: string, body: Buffer) =>
      Buffer.concat([
        Buffer.from(`RIFF\x00\x00\x00\x00WEBP${chunk}\x00\x00\x00\x00`, 'latin1'),
        body,
      ]);
    const lossy = Buffer.alloc(14);
    lossy.writeUInt16LE(1104, 6);
    lossy.writeUInt16LE(309, 8);
    expect(webpSize(riff('VP8 ', lossy))).toStrictEqual({ width: 1104, height: 309 });
    const lossless = Buffer.alloc(5);
    lossless.writeUInt32LE((1103 & 0x3fff) | ((308 & 0x3fff) << 14), 1);
    expect(webpSize(riff('VP8L', lossless))).toStrictEqual({ width: 1104, height: 309 });
    const extended = Buffer.alloc(10);
    extended.writeUIntLE(1103, 4, 3);
    extended.writeUIntLE(308, 7, 3);
    expect(webpSize(riff('VP8X', extended))).toStrictEqual({ width: 1104, height: 309 });
    expect(() => webpSize(riff('ALPH', Buffer.alloc(10)))).toThrow(/not a WebP image/u);
  });

  it('recognise a WebP by its RIFF header, and nothing else as one', () => {
    expect(isWebp(Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1'))).toBe(true);
    expect(isWebp(Buffer.from('\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR', 'latin1'))).toBe(false);
    expect(isWebp(Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1'))).toBe(false);
  });
});
