import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { releasePlan } from './images.mjs';
import { verifyDigestReference } from './verify-reference.mjs';

const [output, tag, platforms, revision] = process.argv.slice(2);
if (!output || !tag || !platforms) {
  process.stderr.write('usage: write-manifest.mjs <output> <tag> <platforms> [revision]\n');
  process.exit(2);
}
// The release plan (infra/release/images.mjs, #370): the manifest holds exactly these images, so
// a release cannot drop one the generator pins or add one nothing asked for.
const planned = releasePlan().map((image) => image.name);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const images = {};
for (const line of input.trim().split(/\r?\n/u)) {
  const separator = line.indexOf('=');
  if (separator < 1) throw new Error(`invalid image record: ${line}`);
  const name = line.slice(0, separator);
  if (!planned.includes(name) || images[name]) {
    throw new Error(`unexpected or duplicate image: ${name}`);
  }
  images[name] = verifyDigestReference(line.slice(separator + 1));
}
for (const required of planned) {
  if (!images[required]) throw new Error(`manifest requires the ${required} image contract`);
}
const manifest = {
  schemaVersion: 1,
  version: tag,
  sourceRevision: revision ?? tag,
  platforms: platforms.split(','),
  images,
};
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
