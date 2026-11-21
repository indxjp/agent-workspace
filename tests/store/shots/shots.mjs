/**
 * The store's screenshots (use-cases plan §6.3): for every live entry, the result card of its
 * recording as the store replays it, in Japanese and in English, at
 * `examples/store/public/shots/<slug>.<ja|en>.webp`. `shoot.mjs` writes them; nobody edits them by
 * hand. `tests/store/shots.test.ts` checks each one exists and is a WebP image.
 */
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Where the store serves the screenshots from (`/shots/<file>`). */
export const SHOTS_DIR = path.join(ROOT, 'examples/store/public/shots');

/** The store's two languages, in the order the shots are taken. */
export const SHOT_LANGS = /** @type {const} */ (['ja', 'en']);

/**
 * The screenshot every live entry has, one per language: its slug, language and file name.
 *
 * @param {readonly { readonly slug: string; readonly status: string }[]} catalog
 */
export function expectedShots(catalog) {
  return catalog
    .filter((entry) => entry.status === 'live')
    .flatMap(({ slug }) =>
      SHOT_LANGS.map((lang) => ({ slug, lang, file: `${slug}.${lang}.webp` })),
    );
}

/**
 * Whether `bytes` are a WebP image: a RIFF container whose form type is `WEBP`.
 *
 * @param {Uint8Array} bytes
 */
export function isWebp(bytes) {
  const text = Buffer.from(bytes.subarray(0, 12)).toString('latin1');
  return text.startsWith('RIFF') && text.slice(8) === 'WEBP';
}

/** The generated file that tells the page each screenshot's size (its `<img>` width and height). */
export const SHOTS_GENERATED = path.join(ROOT, 'examples/store/app/shots.generated.ts');

/**
 * The width and height of a WebP image, from its first chunk: lossy (`VP8 `), lossless (`VP8L`)
 * or extended (`VP8X`).
 *
 * @param {Uint8Array} bytes
 */
export function webpSize(bytes) {
  const data = Buffer.from(bytes);
  const chunk = data.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = data.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
  }
  throw new Error(`not a WebP image this reader knows (first chunk ${JSON.stringify(chunk)})`);
}

/**
 * `shots.generated.ts`: each screenshot's size, keyed `<slug>.<lang>`.
 *
 * @param {Readonly<Record<string, { width: number; height: number }>>} sizes
 */
export function renderShotSizes(sizes) {
  return `// Written by \`node tests/store/shots/shoot.mjs\` with the screenshots; do not edit by hand.
// tests/store/shots.test.ts fails when it differs from the files in public/shots/.

/** Each screenshot's width and height, keyed \`<slug>.<lang>\`, for its \`<img>\`. */
export const SHOTS: Readonly<Record<string, { width: number; height: number }>> = ${JSON.stringify(sizes, null, 2)};
`;
}
